import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import type { Harness } from "@aws-sdk/client-bedrock-agentcore-control";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import {
  AgentCoreCLIError,
  InputValidationError,
  InvalidEnvironmentError,
  ResourceNotFoundError,
} from "../../../errors";
import type { DevEvent, HarnessDevAws } from "../../../handlers/project/dev/types";
import { AsyncChannel, streamProcess, toolAvailable, type ProcessStreamer } from "../../../io";
import type { HarnessRegistryEntry } from "../../../projectSchemas/harness";
import { readHarnessFiles, type HarnessFiles } from "../../project/fsUtils";
import {
  containerCredentials,
  containerRunArgs,
  removeContainer,
  writeContainerEnvFile,
  type ContainerCredentials,
  type ContainerTool,
  type ToolAvailable,
} from "../container";
import { errorMessage, iterateBody } from "../inspector/respond";
import { HARNESS_PLATFORM, harnessImage, pullHarnessImage } from "./image";
import {
  assertLocalSupported,
  harnessEvents,
  omittedReferences,
  toContainerRequest,
  type HarnessInvokeRequest,
} from "./request";

const CONTAINER_PORT = 8080;
const READY_TIMEOUT_MS = 120_000;

type HarnessTurn = { sessionId: string; events: AsyncGenerator<InvokeHarnessStreamOutput> };
type HarnessStatus = {
  name: string;
  phase: "idle" | "starting" | "running" | "failed";
  sessionId?: string;
  error?: string;
};
export type HarnessHostEvent = { agentName?: string; event: DevEvent };

export type HarnessDevHostsConfig = {
  project: { name: string; rootPath: string };
  harnesses: HarnessRegistryEntry[];
  region: string;
  aws: HarnessDevAws;
  environment: (files: HarnessFiles) => Promise<Record<string, string>>;
  hostPort: (name: string) => Promise<number>;
  signal: AbortSignal;
  streamProcess?: ProcessStreamer;
  toolAvailable?: ToolAvailable;
  credentials?: AwsCredentialIdentityProvider;
  processEnv?: NodeJS.ProcessEnv;
  readyIntervalMs?: number;
};

type Host = Omit<HarnessStatus, "name"> & {
  entry: HarnessRegistryEntry;
  busy: boolean;
  removed: boolean;
  port?: number;
  deployed?: Harness;
  stop?: AbortController;
  exited?: Promise<Error | undefined>;
  starting?: Promise<void>;
};

export class HarnessDevHosts {
  private readonly hosts = new Map<string, Host>();
  private readonly channel = new AsyncChannel<HarnessHostEvent>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly streamProcess: ProcessStreamer;
  private readonly toolAvailable: ToolAvailable;
  private readonly credentials: AwsCredentialIdentityProvider;
  private readonly processOptions: { cwd: string; env: NodeJS.ProcessEnv };
  private pulling?: Promise<ContainerTool>;

  constructor(private readonly config: HarnessDevHostsConfig) {
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.toolAvailable = config.toolAvailable ?? toolAvailable;
    this.credentials = config.credentials ?? defaultProvider();
    this.processOptions = { cwd: config.project.rootPath, env: config.processEnv ?? process.env };
    this.setHarnesses(config.harnesses);
    config.signal.addEventListener(
      "abort",
      () => void Promise.allSettled([...this.running]).then(() => this.channel.close()),
      { once: true },
    );
  }

  async *events(): AsyncGenerator<HarnessHostEvent> {
    yield* this.channel;
  }

  snapshot(): HarnessStatus[] {
    return [...this.hosts.values()]
      .filter((host) => !host.removed)
      .map(({ entry, phase, sessionId, error }) => ({ name: entry.name, phase, sessionId, error }));
  }

  setHarnesses(entries: HarnessRegistryEntry[]): void {
    const names = new Set(entries.map(({ name }) => name));
    for (const [name, host] of this.hosts) {
      if (names.has(name)) continue;
      host.removed = true;
      this.retire(host);
    }
    for (const entry of entries) {
      const host = this.hosts.get(entry.name);
      if (host) Object.assign(host, { entry, removed: false });
      else this.hosts.set(entry.name, { entry, phase: "idle", busy: false, removed: false });
    }
  }

  pullImage(): Promise<ContainerTool> {
    this.pulling ??= this.pull().catch((error: unknown) => {
      this.pulling = undefined;
      throw error;
    });
    return this.pulling;
  }

  async start(name: string): Promise<void> {
    const host = this.host(name);
    this.assertIdle(host);
    if (host.starting) return host.starting;
    if (host.phase === "running") return;
    await this.startHost(host, randomUUID());
  }

  async invoke(
    name: string,
    request: HarnessInvokeRequest,
    signal: AbortSignal,
  ): Promise<HarnessTurn> {
    const host = this.host(name);
    this.assertIdle(host);
    host.busy = true;
    try {
      const files = await this.readFiles(host);
      await this.settled(host);
      if (host.removed) this.host(name);
      const sessionId = request.sessionId ?? host.sessionId ?? randomUUID();
      if (host.phase !== "running" || host.sessionId !== sessionId) {
        await this.startHost(host, sessionId, files);
      }
      const { body, apiKey } = toContainerRequest(files, host.deployed, request);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      };
      if (apiKey) {
        headers["X-Amzn-Bedrock-AgentCore-Workload-Access-Token"] = await this.token(name);
      }
      const response = await fetch(`http://127.0.0.1:${host.port}/invocations`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new AgentCoreCLIError(
          `Harness '${name}' returned ${response.status}: ${await response.text()}`,
        );
      }
      return { sessionId, events: this.stream(host, response) };
    } catch (error) {
      this.release(host);
      throw error;
    }
  }

  private assertIdle(host: Host): void {
    if (!host.busy) return;
    throw new InputValidationError(
      `Harness '${host.entry.name}' is busy with session '${host.sessionId}'. Wait for the current turn to finish and retry.`,
    );
  }

  private async settled(host: Host): Promise<void> {
    while (host.starting) await host.starting.catch(() => {});
  }

  private host(name: string): Host {
    const host = this.hosts.get(name);
    if (host && !host.removed) return host;
    const available = this.snapshot()
      .map((status) => status.name)
      .join(", ");
    throw new ResourceNotFoundError(
      `Harness '${name}' was not found. Available harnesses: ${available || "none"}.`,
    );
  }

  private async readFiles(host: Host): Promise<HarnessFiles> {
    const files = await readHarnessFiles(join(this.config.project.rootPath, host.entry.path));
    assertLocalSupported(host.entry.name, files.spec);
    return files;
  }

  private async *stream(host: Host, response: Response): AsyncGenerator<InvokeHarnessStreamOutput> {
    try {
      yield* harnessEvents(iterateBody(response.body));
    } finally {
      this.release(host);
    }
  }

  private release(host: Host): void {
    host.busy = false;
    this.retire(host);
  }

  private retire(host: Host): void {
    if (!host.removed || host.busy || host.starting) return;
    host.stop?.abort();
    this.hosts.delete(host.entry.name);
  }

  private async token(harness: string): Promise<string> {
    const { token, createdIdentity: name } = await this.config.aws.workloadAccessToken();
    if (name) {
      this.status(
        `Created workload identity '${name}' for API key models. Target teardown deletes it. To delete it sooner: aws bedrock-agentcore-control delete-workload-identity --name ${name}`,
        harness,
      );
    }
    return token;
  }

  private status(message: string, name?: string): void {
    this.channel.push({ agentName: name, event: { type: "status", message } });
  }

  private async pull(): Promise<ContainerTool> {
    const pull = pullHarnessImage({
      region: this.config.region,
      ...this.processOptions,
      signal: this.config.signal,
      streamProcess: this.streamProcess,
      toolAvailable: this.toolAvailable,
    });
    for (let next = await pull.next(); ; next = await pull.next()) {
      if (next.done) return next.value;
      this.status(next.value);
    }
  }

  private startHost(host: Host, sessionId: string, files?: HarnessFiles): Promise<void> {
    const starting = this.launch(host, sessionId, files).finally(() => {
      host.starting = undefined;
      this.retire(host);
    });
    host.starting = starting;
    return starting;
  }

  private async launch(host: Host, sessionId: string, files?: HarnessFiles): Promise<void> {
    const name = host.entry.name;
    host.stop?.abort();
    await host.exited;
    host.phase = "starting";
    host.error = undefined;
    host.sessionId = sessionId;
    try {
      const harnessFiles = files ?? (await this.readFiles(host));
      const tool = await this.pullImage();
      host.deployed = await this.config.aws.deployedHarness(name);
      const omitted = omittedReferences(harnessFiles, host.deployed);
      if (omitted.length) {
        this.status(
          `Target not deployed, so running without: ${omitted.join(", ")}. Deploy the target to use them locally.`,
          name,
        );
      }
      const env = await this.config.environment(harnessFiles);
      const containerName = this.containerName(name);
      await removeContainer(this.streamProcess, tool, containerName, this.processOptions);
      host.port = await this.config.hostPort(name);
      const credentials = await containerCredentials(env, this.credentials);
      let envFile: string;
      try {
        envFile = await writeContainerEnvFile(
          { ...credentials.env, ...env },
          this.processOptions.env,
        );
      } catch (error) {
        await credentials.close();
        throw error;
      }
      const command = [
        ...containerRunArgs(tool, containerName, host.port, CONTAINER_PORT),
        "--platform",
        HARNESS_PLATFORM,
        ...credentials.args,
        "--env-file",
        envFile,
        harnessImage(this.config.region),
      ];
      host.stop = new AbortController();
      this.status("Starting container", name);
      const pump = this.pump(host, tool, command, { envFile, credentials }, host.stop);
      host.exited = pump;
      this.running.add(pump);
      void pump.finally(() => this.running.delete(pump));
      await this.waitReady(host, pump);
      host.phase = "running";
      this.status("Ready", name);
    } catch (error) {
      host.phase = "failed";
      host.error = errorMessage(error);
      host.stop?.abort();
      throw error;
    }
  }

  private async pump(
    host: Host,
    tool: ContainerTool,
    command: string[],
    files: { envFile: string; credentials: ContainerCredentials },
    stop: AbortController,
  ): Promise<Error | undefined> {
    const name = host.entry.name;
    const signal = AbortSignal.any([this.config.signal, stop.signal]);
    let failure: Error | undefined;
    try {
      for await (const event of this.streamProcess(command, { ...this.processOptions, signal })) {
        this.channel.push({ agentName: name, event });
      }
    } catch (error) {
      if (!signal.aborted) failure = error as Error;
    } finally {
      await removeContainer(
        this.streamProcess,
        tool,
        this.containerName(name),
        this.processOptions,
      );
      await rm(files.envFile, { force: true });
      await files.credentials.close();
    }
    if (signal.aborted) return undefined;

    failure = failure?.message.includes("exec format error")
      ? new InvalidEnvironmentError(
          "The harness image is linux/arm64 only and this host cannot run it. Enable arm64 emulation in your container tool (for example Rosetta or QEMU in Docker Desktop) and retry.",
        )
      : new InvalidEnvironmentError(
          `Harness '${name}' container exited before it was ready.${failure ? `\n${failure.message}` : ""}`,
        );
    host.phase = "failed";
    host.error = failure.message;
    return failure;
  }

  private async waitReady(host: Host, exited: Promise<Error | undefined>): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let exit: Error | undefined;
    void exited.then((error) => {
      exit =
        error ??
        new InvalidEnvironmentError(
          `Harness '${host.entry.name}' container stopped before it was ready.`,
        );
    });
    while (Date.now() < deadline) {
      this.config.signal.throwIfAborted();
      if (exit) throw exit;
      try {
        const response = await fetch(`http://127.0.0.1:${host.port}/ping`, {
          signal: this.config.signal,
        });
        if (response.ok) return;
      } catch {}
      await sleep(this.config.readyIntervalMs ?? 250, undefined, { signal: this.config.signal });
    }
    throw new InvalidEnvironmentError(
      `Harness '${host.entry.name}' did not answer GET /ping on port ${host.port} within ${READY_TIMEOUT_MS / 1000} s.`,
    );
  }

  private containerName(name: string): string {
    return `agentcore-dev-harness-${this.config.project.name}-${name}`.toLowerCase();
  }
}
