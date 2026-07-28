#!/usr/bin/env node

// The shebang above is preserved by the bundler into dist/index.js, making the
// published `bin` directly executable by Node. It's ignored during development
// when the file is run via `bun run src/index.ts`.

import { homedir } from "os";
import { join } from "path";

import { CoreClient } from "./core";
import { createControlClient, createDataClient, createIamClient } from "./core/factories";
import { createRootHandler } from "./handlers";
import { FsReadWriteJson } from "./io";
import { createFileLogger, LOG_LEVEL } from "./logging";
import { runWithExitCode } from "./runnable";
import { DefaultGlobalConfigAccessor } from "./globalConfig";
import { DefaultTelemetryClient, TelemetryAttributesRecorder } from "./telemetry";
import { AgentCoreCLIError } from "./errors";

process.exit(
  await runWithExitCode(async (argv: string[]) => {
    const startTime = Date.now();
    // generate a unique identifier corresponding to this process of this CLI. (ex. one command invoke, one TUI session)
    const cliSessionId = crypto.randomUUID();

    const rootLogger = createFileLogger({
      filePath: join(homedir(), ".agentcore", "logs", "output"),
      logLevel: LOG_LEVEL.DEBUG,
      bindings: { cliSessionId },
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

    const commandRunTelemetryRecorder = new TelemetryAttributesRecorder("cli.command_run", {
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

      // Handle the request
      await rootHandler.route(argv);
    } catch (e) {
      const error = AgentCoreCLIError.fromError(e);
      rootLogger.child({ error: error.json() }).error();
      // TODO: add error details to telemetry recorder;
      commandRunTelemetryRecorder.record({ exit_reason: "failure" });

      throw error;
    } finally {
      try {
        const attributes = commandRunTelemetryRecorder.getAttributes();
        await telemetryClient.emit("cli.command_run", Date.now() - startTime, attributes);
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
