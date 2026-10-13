import { join } from "node:path";
import z from "zod";
import { createInspectorHandler } from "../../../core/dev/inspector/server";
import type { InspectorDeps } from "../../../core/dev/inspector/types";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { findFreePort, resolveDevPort, resolveDevPorts } from "../../../core/dev/port";
import { projectSpecPath } from "../../../core/project/fsUtils";
import type { V0DeployRunner } from "../../../core/project/legacy/deploy";
import { DevSupervisor, type SupervisorConfig } from "../../../core/dev/supervisor";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  NotImplementedError,
  ResourceNotFoundError,
  SilentCLIError,
} from "../../../errors";
import type { AppIO, BrowserOpener, FileWatcher, PortChecker, startHttpServer } from "../../../io";
import { createHandler, flag, ProjectKey, type Context, type Middleware } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import { JsonRendererKey, type JsonRenderer } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import { coreOptsFromCtx } from "../../utils";
import type { CoreHarnessClient } from "../../harness/types";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { createDeployProjectHandler, DEPLOY_NEXT_STEP } from "../deploy";
import type { Project, ProjectManager } from "../types";
import { BMA_TEMPLATE_NAME, isBmaRuntime } from "../bma";
import type { DevEnvironmentLoader } from "./environment";
import type { DevEvent, DevRunner, DevTraceCollector, DevTraceCollectorStarter } from "./types";

/** The Inspector UI binds 8081 or, when that is taken, the next free port. */
const UI_DEFAULT_PORT = 8081;
const RUNTIME_OPTIONS_GROUP = "Runtime Options:";
const HARNESS_OPTIONS_GROUP = "Harness Options:";

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
  projectManager: ProjectManager;
  harness: Pick<CoreHarnessClient, "getHarness" | "invokeHarness">;
  /** Overrides how the supervisor decides an agent is ready (defaults to a real TCP poll). */
  waitReady?: SupervisorConfig["waitReady"];
  /** Runs the final v0 deployer when harness dev is opened from a v0 project. */
  runV0Deploy?: V0DeployRunner;
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

/** An agent's own output, always tagged with the agent that produced it. */
function renderAgentEvent({
  io,
  event,
  agent,
  json,
}: {
  io: AppIO;
  event: DevEvent;
  agent: string;
  json?: JsonRenderer;
}): void {
  if (json) {
    json.renderJsonLine({ agent, ...event });
    return;
  }

  const output = event.type === "stdout" ? io.stdout : io.stderr;
  const line = event.type === "status" ? event.message : event.line;
  output.write(`[${agent}] ${line}\n`);
}

/** A command-level status line, not attributed to any agent. */
function renderStatus({
  io,
  message,
  json,
}: {
  io: AppIO;
  message: string;
  json?: JsonRenderer;
}): void {
  if (json) {
    json.renderJsonLine({ type: "status", message });
    return;
  }
  io.stderr.write(`${message}\n`);
}

export const createDevProjectHandler = (config: DevProjectHandlerConfig) =>
  createHandler({
    name: "dev",
    description:
      "test project changes: run Runtimes locally or deploy for Harnesses; --mode browser opens Agent Inspector.",
    middlewares: config.middlewares,
    flags: [
      flag("agent", "runtime or harness to run", z.string().min(1).optional()),
      flag(
        "ui-port",
        "port for the Agent Inspector web UI (browser mode)",
        z.coerce.number().int().min(1).max(65535).optional(),
      ),
      flag(
        "mode",
        "how to run: browser (Agent Inspector web UI) or headless (runtime output or harness invoke guidance)",
        z.enum(["browser", "headless"]).default("headless"),
      ),
      flag(
        "port",
        "port for the development server",
        z.coerce.number().int().min(1).max(65535).optional(),
        { group: RUNTIME_OPTIONS_GROUP },
      ),
      flag("traces", "disable local OTEL trace collection", z.boolean().default(true), {
        group: RUNTIME_OPTIONS_GROUP,
      }),
      flag(
        "target",
        'name of the aws-targets.json entry to deploy; the default target is created automatically from your AWS account and region on first deploy (default: "default")',
        z.string().min(1).optional(),
        { group: HARNESS_OPTIONS_GROUP },
      ),
      flag(
        "yes",
        "confirm removing the target's stack when the project declares nothing to deploy",
        z.boolean().default(false),
        { group: HARNESS_OPTIONS_GROUP },
      ),
      flag(
        "skip-deploy",
        "skip deployment and use the deployed harnesses",
        z.boolean().default(false),
        { group: HARNESS_OPTIONS_GROUP },
      ),
    ],
    handle: async (ctx, flags) => {
      const selection = resolveAgentSelection(ctx.require(ProjectKey), flags.agent);
      if (selection.type === "harness") {
        const unsupportedFlags = [
          flags.port !== undefined && "--port",
          !flags.traces && "--no-traces",
        ].filter(Boolean);
        if (unsupportedFlags.length) {
          throw new InputValidationError(
            `${unsupportedFlags.join(", ")} does not apply to harness dev.`,
          );
        }
        await runHarnessDev({
          config,
          ctx,
          input: {
            harnesses: selection.harnesses,
            mode: flags.mode,
            uiPort: flags["ui-port"],
            deploymentTarget: flags.target ?? DEFAULT_TARGET_NAME,
            yes: flags.yes,
            skipDeploy: flags["skip-deploy"],
          },
        });
      } else {
        const unsupportedFlags = (["target", "yes", "skip-deploy"] as const).filter(
          (name) => flags[name],
        );
        if (unsupportedFlags.length) {
          throw new InputValidationError(
            `${unsupportedFlags.map((name) => `--${name}`).join(", ")} does not apply to runtime dev.`,
          );
        }
        await runRuntimeDev({
          config,
          ctx,
          input: {
            runtimes: selection.runtimes,
            agent: flags.agent,
            port: flags.port,
            traces: flags.traces,
            mode: flags.mode,
            uiPort: flags["ui-port"],
          },
        });
      }
    },
  });

type AgentSelection =
  | { type: "harness"; harnesses: Project["spec"]["harnesses"] }
  | { type: "runtime"; runtimes: ProjectRuntime[] };

function resolveAgentSelection(project: Project, agent?: string): AgentSelection {
  const { runtimes, harnesses } = project.spec;
  if (runtimes.length === 0 && harnesses.length === 0) {
    throw new InputValidationError("This project has no runtimes or harnesses.");
  }
  const selectedRuntimes = agent ? runtimes.filter(({ name }) => name === agent) : runtimes;
  const selectedHarnesses = agent ? harnesses.filter(({ name }) => name === agent) : harnesses;
  if (selectedRuntimes.length > 0 && selectedHarnesses.length > 0) {
    const message = agent
      ? `Agent '${agent}' names both a runtime and a harness. Give them distinct names in agentcore.json.`
      : "This project has both runtimes and harnesses. Pass --agent <name> to choose which to run.";
    throw new InputValidationError(message);
  }
  if (selectedHarnesses.length) return { type: "harness", harnesses: selectedHarnesses };
  if (!selectedRuntimes.length) {
    throw new ResourceNotFoundError(
      `Agent '${agent}' was not found. Available agents: ${[...runtimes, ...harnesses].map(({ name }) => name).join(", ")}.`,
    );
  }
  const supportedRuntimes = selectedRuntimes.filter(supportsLocalDev);
  if (!supportedRuntimes.length) {
    throw new NotImplementedError(
      `Local dev is not supported for runtime '${selectedRuntimes[0]!.name}' (${BMA_TEMPLATE_NAME}). ` +
        "Run agentcore deploy, then use client.py to connect through Bedrock Managed Agents.",
      { source: ERROR_SOURCE.USER },
    );
  }
  return { type: "runtime", runtimes: supportedRuntimes };
}

async function runHarnessDev({
  config,
  ctx,
  input,
}: {
  config: DevProjectHandlerConfig;
  ctx: Context;
  input: {
    harnesses: Project["spec"]["harnesses"];
    mode: "browser" | "headless";
    uiPort?: number;
    deploymentTarget: string;
    yes: boolean;
    skipDeploy: boolean;
  };
}): Promise<void> {
  const { harnesses, deploymentTarget } = input;
  if (!input.skipDeploy) {
    await createDeployProjectHandler(config).handle(
      ctx,
      { target: deploymentTarget, yes: input.yes },
      {},
    );
  }
  if (input.mode === "headless" && (input.skipDeploy || ctx.require(JsonKey))) {
    config.io.stderr.write(`Next step:\n  ${DEPLOY_NEXT_STEP}\n`);
  }
  if (input.mode === "headless") return;
  const project = ctx.require(ProjectKey);

  const inspectorProject = {
    ...project,
    spec: {
      ...project.spec,
      runtimes: [],
      harnesses,
    },
  };
  await withUserCancellation(
    async (signal) => {
      let server: Awaited<ReturnType<typeof config.startServer>> | undefined;
      try {
        const uiPort = (await findFreePort(UI_DEFAULT_PORT, input.uiPort, config.checkPort, signal))
          .port;
        server = await config.startServer(
          createInspectorHandler({
            supervisor: {
              snapshot: () => [],
              running: () => undefined,
              start: async (name) => {
                throw new ResourceNotFoundError(`Runtime '${name}' was not found.`);
              },
            },
            project: inspectorProject,
            assets: config.inspectorAssets,
            invokeHarness: async (name, input, requestSignal) => {
              const deployed = await config.projectManager.resolveDeployedResource(project, {
                target: deploymentTarget,
                resourceType: "harness",
                name,
              });
              const options = {
                ...coreOptsFromCtx(ctx),
                region: deployed.target.region,
                credentials: deployed.credentialProvider,
              };
              const detail = await config.harness.getHarness(deployed.id, options);
              if (!detail.harness?.arn)
                throw new ResourceNotFoundError(`Harness '${name}' has no deployed ARN.`);
              return config.harness.invokeHarness(
                { ...input, harnessArn: detail.harness.arn },
                options,
                AbortSignal.any([requestSignal, signal]),
              );
            },
          }),
          { port: uiPort, signal },
        );
        const json = ctx.require(JsonKey) ? ctx.require(JsonRendererKey) : undefined;
        const url = `http://127.0.0.1:${server.port}`;
        renderStatus({ io: config.io, message: `Agent Inspector running at ${url}`, json });
        if (config.isInteractive() && !json) await config.openBrowser(url);
        signal.throwIfAborted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      } finally {
        await server?.close();
      }
    },
    () => config.io.stderr.write("Shutting down…\n"),
  );
}

async function runRuntimeDev({
  config,
  ctx,
  input,
}: {
  config: DevProjectHandlerConfig;
  ctx: Context;
  input: {
    runtimes: ProjectRuntime[];
    agent?: string;
    port?: number;
    traces: boolean;
    mode: "browser" | "headless";
    uiPort?: number;
  };
}): Promise<void> {
  const { runtimes } = input;
  await withUserCancellation(
    async (signal) => {
      const json = ctx.require(JsonKey) ? ctx.require(JsonRendererKey) : undefined;
      let collector: DevTraceCollector | undefined;
      try {
        const project = ctx.require(ProjectKey);
        const region = ctx.require(RegionKey);
        if (runtimes.length > 1 && input.port !== undefined) {
          throw new InputValidationError(
            "--port applies to a single runtime. Use --agent to select one.",
          );
        }
        if (!input.agent) {
          for (const runtime of project.spec.runtimes.filter(
            (runtime) => !supportsLocalDev(runtime),
          )) {
            renderStatus({
              io: config.io,
              message: `Skipping runtime '${runtime.name}': local dev is not supported for ${BMA_TEMPLATE_NAME}.`,
              json,
            });
          }
        }

        collector = input.traces
          ? await startRuntimeTraceCollector({ config, project, runtimes, json })
          : undefined;
        signal.throwIfAborted();

        const getDevEnvVarsForRuntime = async (
          runtime: ProjectRuntime,
        ): Promise<Record<string, string>> => {
          const { env } = await config.loadDevEnvironment({
            projectRoot: project.rootPath,
            runtime,
            region,
          });
          const otel =
            collector && (runtime.instrumentation?.enableOtel ?? true)
              ? otelEnvForRuntime(collector, runtime)
              : {};
          return { ...env, ...otel };
        };

        if (input.mode === "headless" && input.agent) {
          await runWithoutUi({
            config,
            runtime: runtimes[0]!,
            project,
            options: { port: input.port, environment: getDevEnvVarsForRuntime },
            signal,
            json,
          });
          return;
        }

        const assignedPorts =
          input.mode === "headless"
            ? await resolveDevPorts(runtimes, input.port, config.checkPort, signal)
            : undefined;
        const supervisor = new DevSupervisor({
          runtimes,
          projectRoot: project.rootPath,
          runners: config.runners,
          getDevEnvVarsForRuntime,
          // The --port guard above rejects an explicit port with more than one
          // runtime, so passing input.port here only ever applies to a lone one.
          resolvePort: async (runtime) => {
            if (assignedPorts) {
              const assignedPort = assignedPorts.get(runtime.name);
              if (assignedPort === undefined) {
                throw new AgentCoreCLIError(`No port was assigned to runtime '${runtime.name}'.`);
              }
              return assignedPort;
            }
            return (await resolveDevPort(runtime.protocol, input.port, config.checkPort, signal))
              .port;
          },
          waitReady: config.waitReady,
          signal,
        });

        if (input.mode === "headless") {
          void Promise.allSettled(runtimes.map((runtime) => supervisor.start(runtime.name)));
          for await (const { agentName, event } of supervisor.events()) {
            renderAgentEvent({ io: config.io, event, agent: agentName, json });
            const phases = supervisor.snapshot();
            if (phases.every(({ phase }) => phase !== "starting" && phase !== "running")) {
              if (phases.some(({ phase }) => phase === "failed")) throw new SilentCLIError();
              break;
            }
          }
          signal.throwIfAborted();
          return;
        }

        const uiPort = (await findFreePort(UI_DEFAULT_PORT, input.uiPort, config.checkPort, signal))
          .port;
        const server = await config.startServer(
          createInspectorHandler({
            supervisor,
            traces: collector?.traces,
            assets: config.inspectorAssets,
            project: { ...project, spec: { ...project.spec, harnesses: [] } },
            selectedAgent: input.agent,
          }),
          { port: uiPort, signal },
        );

        const onConfigChange = async () => {
          try {
            const reloaded = await config.projectManager.resolve({ filePath: project.rootPath });
            if (!reloaded) return;
            const runtimes = reloaded.spec.runtimes.filter(supportsLocalDev);
            supervisor.setRuntimes(
              input.agent ? runtimes.filter((runtime) => runtime.name === input.agent) : runtimes,
            );
            renderStatus({ io: config.io, message: "Reloaded agents from agentcore.json.", json });
          } catch {
            // A half-saved config parses on the next change event.
          }
        };
        config.watchFile(projectSpecPath(project.rootPath), () => void onConfigChange(), signal);

        const url = `http://127.0.0.1:${server.port}`;
        renderStatus({ io: config.io, message: `Agent Inspector running at ${url}`, json });
        if (config.isInteractive() && !json) await config.openBrowser(url);

        for await (const { agentName, event } of supervisor.events()) {
          renderAgentEvent({ io: config.io, event, agent: agentName, json });
        }
        signal.throwIfAborted();
      } finally {
        // Close only after the runner returns, which is after the child's own
        // shutdown grace, so the agent's final spans still reach the collector.
        await collector?.close();
      }
    },
    () => config.io.stderr.write("Shutting down…\n"),
  );
}

async function startRuntimeTraceCollector({
  config,
  project,
  runtimes,
  json,
}: {
  config: DevProjectHandlerConfig;
  project: Project;
  runtimes: ProjectRuntime[];
  json?: JsonRenderer;
}): Promise<DevTraceCollector | undefined> {
  if (!runtimes.some((runtime) => runtime.instrumentation?.enableOtel ?? true)) return;
  const tracesDirectory = join(project.rootPath, "agentcore", ".cli", "traces", "otlp");
  let tracePersistErrorReported = false;
  const collector = await config.startTraceCollector({
    tracesDirectory,
    // A container reaches the collector over the host bridge, which a loopback bind refuses.
    host: runtimes.some((runtime) => runtime.build === "Container") ? "0.0.0.0" : "127.0.0.1",
    onError: (error) => {
      if (tracePersistErrorReported) return;
      tracePersistErrorReported = true;
      const detail = error instanceof Error ? error.message : String(error);
      renderStatus({
        io: config.io,
        message: `Warning: failed to persist traces to ${tracesDirectory} (${detail}); collected traces may be incomplete.`,
        json,
      });
    },
  });
  try {
    renderStatus({
      io: config.io,
      message: `OTEL collector listening on port ${collector.port}; traces persist to ${tracesDirectory}.`,
      json,
    });
    return collector;
  } catch (error) {
    await collector.close();
    throw error;
  }
}

/**
 * Run one runtime directly. Unlike the supervised Inspector path, a crash here
 * fails the command (scripts and CI rely on the non-zero exit).
 */
async function runWithoutUi({
  config,
  runtime,
  project,
  options,
  signal,
  json,
}: {
  config: DevProjectHandlerConfig;
  runtime: ProjectRuntime;
  project: Project;
  options: {
    port?: number;
    environment: (runtime: ProjectRuntime) => Promise<Record<string, string>>;
  };
  signal: AbortSignal;
  json?: JsonRenderer;
}): Promise<void> {
  const devPort = await resolveDevPort(runtime.protocol, options.port, config.checkPort, signal);
  if (devPort.port !== devPort.requestedPort) {
    renderStatus({
      io: config.io,
      message: `Port ${devPort.requestedPort} is in use; using ${devPort.port}.`,
      json,
    });
  }

  const env = await options.environment(runtime);
  signal.throwIfAborted();

  const runner = config.runners[runtime.build];
  for await (const event of runner.run({
    runtime,
    projectRoot: project.rootPath,
    port: devPort.port,
    env,
    signal,
  })) {
    renderAgentEvent({ io: config.io, event, agent: runtime.name, json });
  }
}
