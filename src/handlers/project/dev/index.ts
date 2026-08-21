import { join } from "node:path";
import z from "zod";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { resolveDevPort } from "../../../core/dev/port";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  ResourceNotFoundError,
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
};

/** Env for a spawned agent so its OTEL SDK reports to the collector as this runtime. */
function otelEnvForRuntime(
  collector: DevTraceCollector,
  runtime: ProjectRuntime,
): Record<string, string> {
  const env = { ...collector.envVars, OTEL_SERVICE_NAME: runtime.name };
  return runtime.build === "Container" ? rewriteOtelEndpointForContainer(env) : env;
}

function selectRuntime(project: Project, name?: string): ProjectRuntime {
  if (project.spec.runtimes.length === 0) {
    throw new InputValidationError(
      "This project has no runtimes. Add a runtime to agentcore/agentcore.json and retry.",
    );
  }
  const available = project.spec.runtimes.map(({ name }) => name).join(", ");

  if (name) {
    const runtime = project.spec.runtimes.find((candidate) => candidate.name === name);
    if (runtime) return runtime;
    throw new ResourceNotFoundError(
      `Runtime '${name}' was not found. Available runtimes: ${available}.`,
    );
  }

  if (project.spec.runtimes.length === 1) return project.spec.runtimes[0]!;
  throw new InputValidationError(
    `Multiple runtimes found. Use --agent to select one. Available runtimes: ${available}.`,
  );
}

function renderEvent(io: AppIO, event: DevEvent, json?: JsonRenderer): void {
  if (json) {
    json.renderJsonLine(event);
    return;
  }

  const output = event.type === "stdout" ? io.stdout : io.stderr;
  output.write(`${event.type === "status" ? event.message : event.line}\n`);
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
        const runtime = selectRuntime(project, flags.agent);
        const devPort = await resolveDevPort(
          runtime.protocol,
          flags.port,
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

        const { env } = await config.loadDevEnvironment({
          projectRoot: project.rootPath,
          runtime,
          region: ctx.require(RegionKey),
        });
        controller.signal.throwIfAborted();

        let otelEnv: Record<string, string> = {};
        if (flags.traces && (runtime.instrumentation?.enableOtel ?? true)) {
          const tracesDirectory = join(project.rootPath, "agentcore", ".cli", "traces", "otlp");
          let tracePersistErrorReported = false;
          collector = await config.startTraceCollector({
            tracesDirectory,
            signal: controller.signal,
            // Persistence can fail after startup (disk, permissions). Warn once —
            // exports are still acked, so without this the loss would be silent.
            onError: (error) => {
              if (tracePersistErrorReported) return;
              tracePersistErrorReported = true;
              const detail = error instanceof Error ? error.message : String(error);
              renderEvent(
                config.io,
                {
                  type: "status",
                  message: `Warning: failed to persist traces to ${tracesDirectory} (${detail}); collected traces may be incomplete.`,
                },
                json,
              );
            },
          });
          otelEnv = otelEnvForRuntime(collector, runtime);
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

        const runner = config.runners[runtime.build];
        for await (const event of runner.run({
          runtime,
          projectRoot: project.rootPath,
          port: devPort.port,
          env: { ...env, ...otelEnv },
          signal: controller.signal,
        })) {
          renderEvent(config.io, event, json);
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        for (const signal of signals) process.removeListener(signal, interrupt);
        await collector?.close();
      }
    },
  });
