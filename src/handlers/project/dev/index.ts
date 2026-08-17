import { join } from "node:path";
import z from "zod";
import { createInspectorHandler } from "../../../core/dev/inspector/server";
import type { InspectorDeps } from "../../../core/dev/inspector/types";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { PortInUseError, resolveDevPort } from "../../../core/dev/port";
import { DevSupervisor } from "../../../core/dev/supervisor";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  CommandInterruptedError,
  InputValidationError,
  ResourceNotFoundError,
} from "../../../errors";
import type { AppIO, BrowserOpener, PortChecker, startHttpServer } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey, type JsonRenderer } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project } from "../types";
import type { DevEnvironmentLoader } from "./environment";
import type { DevEvent, DevRunner, DevTraceCollector, DevTraceCollectorStarter } from "./types";

const UI_DEFAULT_PORT = 8081;
const UI_PORT_ATTEMPTS = 100;

export type DevProjectHandlerConfig = {
  io: AppIO;
  runners: { CodeZip: DevRunner; Container: DevRunner };
  loadDevEnvironment: DevEnvironmentLoader;
  checkPort: PortChecker;
  startTraceCollector: DevTraceCollectorStarter;
  startServer: typeof startHttpServer;
  openBrowser: BrowserOpener;
  inspectorAssets: InspectorDeps["assets"];
  /** Whether the command runs on an interactive terminal (gates browser auto-open). */
  isInteractive: () => boolean;
};

/** Env for a spawned agent so its OTEL SDK reports to the collector as this runtime. */
function otelEnvForRuntime(
  collector: DevTraceCollector,
  runtime: ProjectRuntime,
): Record<string, string> {
  const env = { ...collector.envVars, OTEL_SERVICE_NAME: runtime.name };
  return runtime.build === "Container" ? rewriteOtelEndpointForContainer(env) : env;
}

function selectRuntimes(project: Project, name?: string): ProjectRuntime[] {
  if (project.spec.runtimes.length === 0) {
    throw new InputValidationError(
      "This project has no runtimes. Add a runtime to agentcore/agentcore.json and retry.",
    );
  }
  if (!name) return project.spec.runtimes;

  const runtime = project.spec.runtimes.find((candidate) => candidate.name === name);
  if (runtime) return [runtime];
  const available = project.spec.runtimes.map((candidate) => candidate.name).join(", ");
  throw new ResourceNotFoundError(
    `Runtime '${name}' was not found. Available runtimes: ${available}.`,
  );
}

/** In --no-ui mode exactly one runtime streams to the terminal, as before. */
function selectSingleRuntime(project: Project, name?: string): ProjectRuntime {
  const runtimes = selectRuntimes(project, name);
  if (runtimes.length === 1) return runtimes[0]!;
  const available = runtimes.map(({ name: runtimeName }) => runtimeName).join(", ");
  throw new InputValidationError(
    `Multiple runtimes found. Use --agent to select one. Available runtimes: ${available}.`,
  );
}

function renderEvent(io: AppIO, event: DevEvent, json?: JsonRenderer, agent?: string): void {
  if (json) {
    json.renderJsonLine(agent === undefined ? event : { agent, ...event });
    return;
  }

  const output = event.type === "stdout" ? io.stdout : io.stderr;
  const line = event.type === "status" ? event.message : event.line;
  output.write(agent === undefined ? `${line}\n` : `[${agent}] ${line}\n`);
}

export const createDevProjectHandler = (config: DevProjectHandlerConfig) =>
  createHandler({
    name: "dev",
    description: "run the project locally for development",
    flags: [
      flag("agent", "runtime to run", z.string().optional()),
      flag(
        "port",
        "port for the development server",
        z.coerce.number().int().min(1).max(65535).optional(),
      ),
      flag("traces", "disable local OTEL trace collection", z.boolean().default(true)),
      flag("ui", "run without the Agent Inspector web UI", z.boolean().default(true)),
      flag(
        "ui-port",
        "port for the Agent Inspector web UI",
        z.coerce.number().int().min(1).max(65535).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const controller = new AbortController();
      const json = ctx.require(JsonKey) ? ctx.require(JsonRendererKey) : undefined;
      const interrupt = () => {
        if (controller.signal.aborted) return;
        config.io.stderr.write("Shutting down…\n");
        controller.abort();
      };

      const signals = ["SIGINT", "SIGTERM"] as const;
      for (const signal of signals) process.on(signal, interrupt);
      let collector: DevTraceCollector | undefined;
      try {
        const project = ctx.require(ProjectKey);
        const region = ctx.require(RegionKey);
        const runtimes = flags.ui
          ? selectRuntimes(project, flags.agent)
          : [selectSingleRuntime(project, flags.agent)];

        if (
          flags.traces &&
          runtimes.some((runtime) => runtime.instrumentation?.enableOtel ?? true)
        ) {
          const tracesDirectory = join(project.rootPath, "agentcore", ".cli", "traces", "otlp");
          collector = await config.startTraceCollector({
            tracesDirectory,
            signal: controller.signal,
          });
          renderEvent(
            config.io,
            {
              type: "status",
              message: `OTEL collector listening on port ${collector.port}; traces persist to ${tracesDirectory}.`,
            },
            json,
          );
        }
        controller.signal.throwIfAborted();

        const environment = async (runtime: ProjectRuntime): Promise<Record<string, string>> => {
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

        if (!flags.ui) {
          await runWithoutUi(
            config,
            runtimes[0]!,
            project,
            flags.port,
            environment,
            controller,
            json,
          );
          return;
        }

        const supervisor = new DevSupervisor({
          runtimes,
          projectRoot: project.rootPath,
          runners: config.runners,
          environment,
          resolvePort: async (runtime) =>
            (
              await resolveDevPort(
                runtime.protocol,
                runtimes.length === 1 ? flags.port : undefined,
                config.checkPort,
                controller.signal,
              )
            ).port,
          signal: controller.signal,
        });

        const uiPort = await resolveUiPort(flags["ui-port"], config.checkPort, controller.signal);
        const server = await config.startServer(
          createInspectorHandler({
            supervisor,
            traces: collector?.traces,
            assets: config.inspectorAssets,
            project,
            selectedAgent: flags.agent,
          }),
          { port: uiPort, signal: controller.signal },
        );

        const url = `http://127.0.0.1:${server.port}`;
        renderEvent(
          config.io,
          { type: "status", message: `Agent Inspector running at ${url}` },
          json,
        );
        if (config.isInteractive() && !json) await config.openBrowser(url);

        for await (const { agent, event } of supervisor.events()) {
          renderEvent(config.io, event, json, agent);
        }
        controller.signal.throwIfAborted();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        throw new CommandInterruptedError(error, true);
      } finally {
        for (const signal of signals) process.removeListener(signal, interrupt);
        await collector?.close();
      }
    },
  });

/** The pre-Inspector behavior: run one runtime and stream its output directly. */
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
    renderEvent(
      config.io,
      {
        type: "status",
        message: `Port ${devPort.requestedPort} is in use; using ${devPort.port}.`,
      },
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
    renderEvent(config.io, event, json);
  }
}

/** The Inspector UI binds 8081 or the next free port; an explicit port must be free. */
async function resolveUiPort(
  explicitPort: number | undefined,
  checkPort: PortChecker,
  signal: AbortSignal,
): Promise<number> {
  if (explicitPort !== undefined) {
    if (await checkPort(explicitPort, signal)) return explicitPort;
    throw new PortInUseError(explicitPort);
  }
  for (let port = UI_DEFAULT_PORT; port < UI_DEFAULT_PORT + UI_PORT_ATTEMPTS; port++) {
    if (await checkPort(port, signal)) return port;
  }
  throw new PortInUseError(UI_DEFAULT_PORT);
}
