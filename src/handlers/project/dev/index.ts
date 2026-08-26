import { join } from "node:path";
import z from "zod";
import { createInspectorHandler } from "../../../core/dev/inspector/server";
import type { InspectorDeps } from "../../../core/dev/inspector/types";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { findFreePort, resolveDevPort } from "../../../core/dev/port";
import { projectSpecPath } from "../../../core/project/fsUtils";
import { DevSupervisor, type SupervisorConfig } from "../../../core/dev/supervisor";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  ResourceNotFoundError,
  UserCancellationError,
} from "../../../errors";
import type { AppIO, BrowserOpener, FileWatcher, PortChecker, startHttpServer } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey, type JsonRenderer } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project } from "../types";
import type { DevEnvironmentLoader } from "./environment";
import type { DevEvent, DevRunner, DevTraceCollector, DevTraceCollectorStarter } from "./types";

/** The Inspector UI binds 8081 or, when that is taken, the next free port. */
const UI_DEFAULT_PORT = 8081;

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
  /** Watches agentcore.json so the Inspector reflects config edits live. */
  watchFile: FileWatcher;
  /** Re-reads the project's runtime definitions after a config change. */
  reloadRuntimes: (projectRoot: string) => Promise<ProjectRuntime[]>;
  /** Overrides how the supervisor decides an agent is ready (defaults to a real TCP poll). */
  waitReady?: SupervisorConfig["waitReady"];
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
        controller.abort(new UserCancellationError());
      };

      const signals = ["SIGINT", "SIGTERM"] as const;
      for (const signal of signals) process.on(signal, interrupt);
      let collector: DevTraceCollector | undefined;
      try {
        const project = ctx.require(ProjectKey);
        const region = ctx.require(RegionKey);
        const runtimes = selectRuntimes(project, flags.agent);
        if (!flags.ui && !flags.agent) {
          const available = runtimes.map((runtime) => runtime.name).join(", ");
          throw new InputValidationError(
            `--no-ui runs a single agent in the terminal. Pass --agent <name> to choose which one. Available: ${available}.`,
          );
        }
        if (runtimes.length > 1 && flags.port !== undefined) {
          throw new InputValidationError(
            "--port applies to a single runtime. Use --agent to select one.",
          );
        }

        if (
          flags.traces &&
          runtimes.some((runtime) => runtime.instrumentation?.enableOtel ?? true)
        ) {
          const tracesDirectory = join(project.rootPath, "agentcore", ".cli", "traces", "otlp");
          let tracePersistErrorReported = false;
          collector = await config.startTraceCollector({
            tracesDirectory,
            // A container reaches the collector over the host bridge, which a
            // 127.0.0.1 bind refuses, so bind all interfaces when any runtime
            // is a container.
            host: runtimes.some((runtime) => runtime.build === "Container")
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
            getDevEnvVarsForRuntime,
            controller,
            json,
          );
          return;
        }

        const supervisor = new DevSupervisor({
          runtimes,
          projectRoot: project.rootPath,
          runners: config.runners,
          getDevEnvVarsForRuntime,
          // The --port guard above rejects an explicit port with more than one
          // runtime, so passing flags.port here only ever applies to a lone one.
          resolvePort: async (runtime) =>
            (
              await resolveDevPort(
                runtime.protocol,
                flags.port,
                config.checkPort,
                controller.signal,
              )
            ).port,
          waitReady: config.waitReady,
          signal: controller.signal,
        });

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
          }),
          { port: uiPort, signal: controller.signal },
        );

        const onConfigChange = async () => {
          try {
            const reloaded = await config.reloadRuntimes(project.rootPath);
            supervisor.setRuntimes(
              flags.agent ? reloaded.filter((runtime) => runtime.name === flags.agent) : reloaded,
            );
            renderStatus(config.io, "Reloaded agents from agentcore.json.", json);
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

        for await (const { agentName, event } of supervisor.events()) {
          renderAgentEvent(config.io, event, agentName, json);
        }
        controller.signal.throwIfAborted();
      } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        for (const signal of signals) process.removeListener(signal, interrupt);
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
