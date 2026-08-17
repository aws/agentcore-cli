#!/usr/bin/env node

// The shebang above is preserved by the bundler into dist/index.js, making the
// published `bin` directly executable by Node. It's ignored during development
// when the file is run via `bun run src/index.ts`.

import { homedir } from "os";
import { join } from "path";

import { CoreClient } from "./core";
import {
  createControlClient,
  createDataClient,
  createIamClient,
  createLogsClient,
} from "./core/factories";
import { createRootHandler } from "./handlers";
import { FsReadWriteJson } from "./io";
import { createFileLogger, logFilePath, LOG_LEVEL } from "./logging";
import { runWithExitCode } from "./runnable";
import { DefaultGlobalConfigAccessor } from "./globalConfig";
import { DefaultTelemetryClient } from "./telemetry";
import { AgentCoreCLIError } from "./errors";
import { PACKAGE_VERSION } from "./constants";
import { CommandRunMetricEventKey, ValueContext } from "./router";

process.exit(
  await runWithExitCode(async (argv: string[]) => {
    const startTime = Date.now();
    // generate a unique identifier corresponding to this process of this CLI. (ex. one command invoke, one TUI session)
    const cliSessionId = crypto.randomUUID();

    const rootLogger = createFileLogger({
      // The standard location, shared with the commands that print where it is: one file
      // for this run, beside the rest of the CLI's own state.
      filePath: logFilePath(),
      logLevel: LOG_LEVEL.DEBUG,
      bindings: { cliSessionId, version: PACKAGE_VERSION },
    });

    const io = {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    };

    const globalConfigAccessor = new DefaultGlobalConfigAccessor({
      logger: rootLogger.child({ module: "globalConfigAccessor" }),
      filePath: join(homedir(), ".agentcore", "config.json"),
      json: new FsReadWriteJson({
        logger: rootLogger.child({ module: "jsonDataSource" }),
      }),
    });

    const telemetryClient = new DefaultTelemetryClient({
      logger: rootLogger.child({ module: "telemetry" }),
      sessionId: cliSessionId,
      globalConfigAccessor,
    });

    const commandRunMetricEvent = telemetryClient.createMetricEvent("cli.command_run", {
      exit_reason: "success",
    });

    try {
      rootLogger.info(`running CLI`);

      // factories (rather than instances) lets CoreClient build one client per
      // region on demand.
      const coreClient = new CoreClient({
        createControlClient,
        createDataClient,
        createIamClient,
        createLogsClient,
        logger: rootLogger.child({ module: "core" }),
      });

      // Pass it to the root handler, along with the process's standard streams as
      // the app's io. CoreClient exposes feature sub-clients (e.g. `.harness`), so
      // it satisfies the Core contract directly.
      const rootHandler = createRootHandler(coreClient, {
        io,
        logger: rootLogger,
        globalConfigAccessor,
      });

      const context = ValueContext.EmptyContext().withValue(
        CommandRunMetricEventKey,
        commandRunMetricEvent,
      );

      // Handle the request
      await rootHandler.route(argv, context);
    } catch (e) {
      const error = AgentCoreCLIError.fromError(e);
      rootLogger.child({ error: error.json() }).error();
      commandRunMetricEvent.setAttributes({
        exit_reason: "failure",
        error_name: error.name,
        error_source: error.source,
      });
      throw error;
    } finally {
      try {
        await commandRunMetricEvent.emit(Date.now() - startTime);
      } catch (e) {
        const error = AgentCoreCLIError.fromError(e);
        rootLogger.child({ error: error.json() }).warn("failed to emit telemetry");
        // telemetry is best-effort
      }
      await telemetryClient.shutdown();
      await rootLogger.end();
    }
  }),
);
