import { join } from "node:path";
import z from "zod";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { resolveDevPort } from "../../../core/dev/port";
import { DevSupervisor, type SupervisorConfig } from "../../../core/dev/supervisor";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { AppIO, PortChecker } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey, type JsonRenderer } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project } from "../types";
import type { DevEnvironmentLoader } from "./environment";
import type { DevEvent, DevRunner, DevTraceCollector, DevTraceCollectorStarter } from "./types";

export type DevProjectHandlerConfig = {
  io: AppIO;
  runners: { CodeZip: DevRunner; Container: DevRunner };
  loadDevEnvironment: DevEnvironmentLoader;
  checkPort: PortChecker;
  startTraceCollector: DevTraceCollectorStarter;
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

        const supervisor = new DevSupervisor({
          runtimes,
          projectRoot: project.rootPath,
          runners: config.runners,
          getDevEnvVarsForRuntime,
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

        const starts = Promise.allSettled(
          runtimes.map((runtime) => supervisor.start(runtime.name)),
        );

        for await (const { agentName, event } of supervisor.events()) {
          renderAgentEvent(config.io, event, agentName, json);
          if (controller.signal.aborted) break;
          const phases = supervisor.snapshot();
          if (phases.every(({ phase }) => phase !== "starting" && phase !== "running")) {
            if (phases.some(({ phase }) => phase === "failed")) throw new SilentCLIError();
            break;
          }
        }
        controller.signal.throwIfAborted();
        await starts;
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
