import { join } from "node:path";
import z from "zod";
import type { HarnessDevHostsConfig, HarnessHostEvent } from "../../../core/dev/harness/hosts";
import { errorMessage } from "../../../core/dev/inspector/respond";
import { createInspectorHandler } from "../../../core/dev/inspector/server";
import type { InspectorDeps } from "../../../core/dev/inspector/types";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { findFreePort, resolveDevPort, resolveDevPorts } from "../../../core/dev/port";
import { projectSpecPath } from "../../../core/project/fsUtils";
import { DevSupervisor, type SupervisorConfig } from "../../../core/dev/supervisor";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import type { HarnessRegistryEntry } from "../../../projectSchemas/harness";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  NotImplementedError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import {
  type AppIO,
  type BrowserOpener,
  type FileWatcher,
  type PortChecker,
  type startHttpServer,
} from "../../../io";
import { createHandler, flag, ProjectKey, type Middleware } from "../../../router";
import { JsonRendererKey, type JsonRenderer } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project, ProjectManager } from "../types";
import { BMA_TEMPLATE_NAME, isBmaRuntime } from "../bma";
import type { DevEnvironmentLoader } from "./environment";
import { startHarnessHosts, type DevHarnessHosts } from "./harness";
import type {
  DevEvent,
  DevRunner,
  DevTraceCollector,
  DevTraceCollectorStarter,
  HarnessDevAws,
} from "./types";

/** The Inspector UI binds 8081 or, when that is taken, the next free port. */
const UI_DEFAULT_PORT = 8081;

export type DevProjectHandlerConfig = {
  io: AppIO;
  middlewares?: Middleware[];
  runners: { CodeZip: DevRunner; Container: DevRunner };
  loadDevEnvironment: DevEnvironmentLoader;
  checkPort: PortChecker;
  startTraceCollector: DevTraceCollectorStarter;
  startServer: typeof startHttpServer;
  openBrowser: BrowserOpener;
  inspectorAssets: InspectorDeps["assets"];
  /** Whether the command runs on an interactive terminal (gates browser auto-open). */
  isInteractive: () => boolean;
  /** Watches agentcore.json so the Inspector reflects config edits live. */
  watchFile: FileWatcher;
  /** Re-resolves the project after a config change to pick up runtime edits. */
  projectManager: Pick<ProjectManager, "resolve">;
  /** Overrides how the supervisor decides an agent is ready (defaults to a real TCP poll). */
  waitReady?: SupervisorConfig["waitReady"];
  /** Builds the AWS access local harnesses need for one project and target. */
  harnessDevAws: (project: Project, target: string, region: string) => HarnessDevAws;
  /** Overrides the harness hosts (tests inject a fake). */
  createHarnessHosts?: (config: HarnessDevHostsConfig) => DevHarnessHosts;
};

/** Env for a spawned agent so its OTEL SDK reports to the collector as this runtime. */
function otelEnvForRuntime(
  collector: DevTraceCollector,
  runtime: ProjectRuntime,
): Record<string, string> {
  const env = { ...collector.envVars, OTEL_SERVICE_NAME: runtime.name };
  return runtime.build === "Container" ? rewriteOtelEndpointForContainer(env) : env;
}

function supportsLocalDev(runtime: ProjectRuntime): boolean {
  return !isBmaRuntime(runtime);
}

function unsupportedRuntimeError(runtime: ProjectRuntime): NotImplementedError {
  return new NotImplementedError(
    `Local dev is not supported for runtime '${runtime.name}' (${BMA_TEMPLATE_NAME}). ` +
      "Run agentcore deploy, then use client.py to connect through Bedrock Managed Agents.",
    { source: ERROR_SOURCE.USER },
  );
}

function pick<T extends { name: string }>(items: T[], name: string, label: string, plural: string) {
  const item = items.find((candidate) => candidate.name === name);
  if (item) return item;
  const available = items.map((candidate) => candidate.name).join(", ");
  throw new ResourceNotFoundError(
    `${label} '${name}' was not found. Available ${plural}: ${available || "none"}.`,
  );
}

function selectResources(
  project: Project,
  flags: { agent?: string; harness?: string },
): { runtimes: ProjectRuntime[]; harnesses: HarnessRegistryEntry[] } {
  const { runtimes, harnesses } = project.spec;
  if (flags.agent && flags.harness) {
    throw new InputValidationError("--agent and --harness cannot be used together.");
  }
  if (runtimes.length === 0 && harnesses.length === 0) {
    throw new InputValidationError("This project has no runtimes or harnesses. Add one and retry.");
  }
  if (flags.harness) {
    return { runtimes: [], harnesses: [pick(harnesses, flags.harness, "Harness", "harnesses")] };
  }
  if (flags.agent) {
    const runtime = pick(runtimes, flags.agent, "Runtime", "runtimes");
    if (!supportsLocalDev(runtime)) throw unsupportedRuntimeError(runtime);
    return { runtimes: [runtime], harnesses: [] };
  }
  const supported = runtimes.filter(supportsLocalDev);
  if (supported.length === 0 && harnesses.length === 0) throw unsupportedRuntimeError(runtimes[0]!);
  return { runtimes: supported, harnesses };
}

/** An agent's own output, always tagged with the agent that produced it. */
function renderAgentEvent(io: AppIO, event: DevEvent, agent: string, json?: JsonRenderer): void {
  if (json) {
    json.renderJsonLine({ agent, ...event });
    return;
  }

  const output = event.type === "stdout" ? io.stdout : io.stderr;
  const line = event.type === "status" ? event.message : event.line;
  output.write(`[${agent}] ${line}\n`);
}

/** A command-level status line, not attributed to any agent. */
function renderStatus(io: AppIO, message: string, json?: JsonRenderer): void {
  if (json) {
    json.renderJsonLine({ type: "status", message });
    return;
  }
  io.stderr.write(`${message}\n`);
}

function renderDevEvent(io: AppIO, { agentName, event }: HarnessHostEvent, json?: JsonRenderer) {
  if (agentName) renderAgentEvent(io, event, agentName, json);
  else if (event.type === "status") renderStatus(io, event.message, json);
}

async function renderDevEvents(
  io: AppIO,
  json: JsonRenderer | undefined,
  ...streams: AsyncIterable<HarnessHostEvent>[]
): Promise<void> {
  await Promise.all(
    streams.map(async (events) => {
      for await (const event of events) renderDevEvent(io, event, json);
    }),
  );
}

export const createDevProjectHandler = (config: DevProjectHandlerConfig) =>
  createHandler({
    name: "dev",
    description: "run the project locally for development",
    middlewares: config.middlewares,
    flags: [
      flag("agent", "Runtime to run", z.string().optional()),
      flag("harness", "Harness to run", z.string().optional()),
      flag(
        "target",
        "deployment target whose resources local harnesses reference",
        z.string().min(1).default(DEFAULT_TARGET_NAME),
      ),
      flag(
        "port",
        "port for the selected runtime, or the harness endpoint with --harness",
        z.coerce.number().int().min(1).max(65535).optional(),
      ),
      flag("traces", "disable local OTEL trace collection", z.boolean().default(true)),
      flag(
        "mode",
        "how to run: browser (Agent Inspector web UI) or headless (agents stream to the terminal)",
        z.enum(["browser", "headless"]).default("headless"),
      ),
      flag(
        "ui-port",
        "port for the Agent Inspector web UI (browser mode)",
        z.coerce.number().int().min(1).max(65535).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const controller = new AbortController();
      const json = ctx.require(JsonKey) ? ctx.require(JsonRendererKey) : undefined;
      const interrupt = () => {
        if (controller.signal.aborted) return;
        config.io.stderr.write("Shutting down…\n");
        controller.abort(new UserCancellationError());
      };

      const signals = ["SIGINT", "SIGTERM"] as const;
      for (const signal of signals) process.on(signal, interrupt);
      let collector: DevTraceCollector | undefined;
      let harnessHosts: DevHarnessHosts | undefined;
      try {
        const project = ctx.require(ProjectKey);
        const region = ctx.require(RegionKey);
        const { runtimes, harnesses } = selectResources(project, flags);
        const harnessPort = flags.harness || runtimes.length === 0 ? flags.port : undefined;
        const runtimePort = harnessPort === undefined ? flags.port : undefined;
        if (runtimes.length > 1 && runtimePort !== undefined) {
          throw new InputValidationError(
            "--port applies to a single runtime. Use --agent to select one.",
          );
        }
        if (!flags.agent && !flags.harness) {
          for (const runtime of project.spec.runtimes.filter(
            (runtime) => !supportsLocalDev(runtime),
          )) {
            renderStatus(
              config.io,
              `Skipping runtime '${runtime.name}': local dev is not supported for ${BMA_TEMPLATE_NAME}.`,
              json,
            );
          }
        }

        if (
          flags.traces &&
          (harnesses.length > 0 ||
            runtimes.some((runtime) => runtime.instrumentation?.enableOtel ?? true))
        ) {
          const tracesDirectory = join(project.rootPath, "agentcore", ".cli", "traces", "otlp");
          let tracePersistErrorReported = false;
          collector = await config.startTraceCollector({
            tracesDirectory,
            // A container reaches the collector over the host bridge, which a
            // 127.0.0.1 bind refuses, so bind all interfaces when any runtime
            // or harness runs in a container.
            host:
              harnesses.length > 0 || runtimes.some((runtime) => runtime.build === "Container")
                ? "0.0.0.0"
                : "127.0.0.1",
            // Persistence can fail after startup (disk, permissions). Warn once —
            // exports are still acked, so without this the loss would be silent.
            onError: (error) => {
              if (tracePersistErrorReported) return;
              tracePersistErrorReported = true;
              const detail = error instanceof Error ? error.message : String(error);
              renderStatus(
                config.io,
                `Warning: failed to persist traces to ${tracesDirectory} (${detail}); collected traces may be incomplete.`,
                json,
              );
            },
          });
          renderStatus(
            config.io,
            `OTEL collector listening on port ${collector.port}; traces persist to ${tracesDirectory}.`,
            json,
          );
        }
        controller.signal.throwIfAborted();

        const getDevEnvVarsForRuntime = async (
          runtime: ProjectRuntime,
        ): Promise<Record<string, string>> => {
          const { env } = await config.loadDevEnvironment({
            projectRoot: project.rootPath,
            env: Object.fromEntries(
              (runtime.envVars ?? []).map(({ name, value }) => [name, value]),
            ),
            region,
          });
          const otel =
            collector && (runtime.instrumentation?.enableOtel ?? true)
              ? otelEnvForRuntime(collector, runtime)
              : {};
          return { ...env, ...otel };
        };

        if (harnesses.length) {
          const endpoint = await startHarnessHosts(config, project, harnesses, {
            region,
            target: flags.target,
            port: harnessPort,
            collector,
            signal: controller.signal,
          });
          harnessHosts = endpoint.hosts;
          renderStatus(config.io, `Harness endpoint listening on port ${endpoint.port}.`, json);
          if (flags.harness) {
            harnessHosts.start(flags.harness).catch((error: unknown) => controller.abort(error));
          }
        }

        if (flags.mode === "headless" && flags.agent) {
          await runWithoutUi(
            config,
            runtimes[0]!,
            project,
            runtimePort,
            getDevEnvVarsForRuntime,
            controller,
            json,
          );
          return;
        }

        const assignedPorts =
          flags.mode === "headless"
            ? await resolveDevPorts(runtimes, runtimePort, config.checkPort, controller.signal)
            : undefined;
        const supervisor = new DevSupervisor({
          runtimes,
          projectRoot: project.rootPath,
          runners: config.runners,
          getDevEnvVarsForRuntime,
          // The --port guard above rejects an explicit port with more than one
          // runtime, so passing runtimePort here only ever applies to a lone one.
          resolvePort: async (runtime) => {
            if (assignedPorts) {
              const assignedPort = assignedPorts.get(runtime.name);
              if (assignedPort === undefined) {
                throw new AgentCoreCLIError(`No port was assigned to runtime '${runtime.name}'.`);
              }
              return assignedPort;
            }
            return (
              await resolveDevPort(
                runtime.protocol,
                runtimePort,
                config.checkPort,
                controller.signal,
              )
            ).port;
          },
          waitReady: config.waitReady,
          signal: controller.signal,
        });

        if (flags.mode === "headless") {
          void Promise.allSettled(runtimes.map((runtime) => supervisor.start(runtime.name)));
          if (harnessHosts) {
            await renderDevEvents(config.io, json, supervisor.events(), harnessHosts.events());
          } else {
            for await (const { agentName, event } of supervisor.events()) {
              renderAgentEvent(config.io, event, agentName, json);
              const phases = supervisor.snapshot();
              if (phases.every(({ phase }) => phase !== "starting" && phase !== "running")) {
                if (phases.some(({ phase }) => phase === "failed")) throw new SilentCLIError();
                break;
              }
            }
          }
          controller.signal.throwIfAborted();
          return;
        }

        const uiPort = (
          await findFreePort(UI_DEFAULT_PORT, flags["ui-port"], config.checkPort, controller.signal)
        ).port;
        const server = await config.startServer(
          createInspectorHandler({
            supervisor,
            traces: collector?.traces,
            assets: config.inspectorAssets,
            project,
            selectedAgent: flags.agent,
            harnesses: harnessHosts,
          }),
          { port: uiPort, signal: controller.signal },
        );
        if (!flags.harness) {
          void harnessHosts
            ?.pullImage()
            .catch((error: unknown) =>
              renderStatus(config.io, `Harness image pull failed: ${errorMessage(error)}`, json),
            );
        }

        const onConfigChange = async () => {
          try {
            const reloaded = await config.projectManager.resolve({ filePath: project.rootPath });
            if (!reloaded) return;
            const selected = selectResources(reloaded, flags);
            supervisor.setRuntimes(selected.runtimes);
            harnessHosts?.setHarnesses(selected.harnesses);
            renderStatus(config.io, "Reloaded agents and harnesses from agentcore.json.", json);
          } catch {
            // A half-saved config parses on the next change event.
          }
        };
        config.watchFile(
          projectSpecPath(project.rootPath),
          () => void onConfigChange(),
          controller.signal,
        );

        const url = `http://127.0.0.1:${server.port}`;
        renderStatus(config.io, `Agent Inspector running at ${url}`, json);
        if (config.isInteractive() && !json) await config.openBrowser(url);

        await renderDevEvents(
          config.io,
          json,
          supervisor.events(),
          ...(harnessHosts ? [harnessHosts.events()] : []),
        );
        controller.signal.throwIfAborted();
      } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        for (const signal of signals) process.removeListener(signal, interrupt);
        controller.abort();
        /** Host events end only after every harness container is removed. **/
        if (harnessHosts) {
          for await (const _event of harnessHosts.events()) {
          }
        }
        // Close only after the runner returns, which is after the child's own
        // shutdown grace, so the agent's final spans still reach the collector.
        await collector?.close();
      }
    },
  });

/**
 * Run one runtime directly. Unlike the supervised Inspector path, a crash here
 * fails the command (scripts and CI rely on the non-zero exit).
 */
async function runWithoutUi(
  config: DevProjectHandlerConfig,
  runtime: ProjectRuntime,
  project: Project,
  explicitPort: number | undefined,
  environment: (runtime: ProjectRuntime) => Promise<Record<string, string>>,
  controller: AbortController,
  json?: JsonRenderer,
): Promise<void> {
  const devPort = await resolveDevPort(
    runtime.protocol,
    explicitPort,
    config.checkPort,
    controller.signal,
  );
  if (devPort.port !== devPort.requestedPort) {
    renderStatus(
      config.io,
      `Port ${devPort.requestedPort} is in use; using ${devPort.port}.`,
      json,
    );
  }

  const env = await environment(runtime);
  controller.signal.throwIfAborted();

  const runner = config.runners[runtime.build];
  for await (const event of runner.run({
    runtime,
    projectRoot: project.rootPath,
    port: devPort.port,
    env,
    signal: controller.signal,
  })) {
    renderAgentEvent(config.io, event, runtime.name, json);
  }
}
