#!/usr/bin/env node

// The shebang above is preserved by the bundler into dist/index.js, making the
// published `bin` directly executable by Node. It's ignored during development
// when the file is run via `bun run src/index.ts`.

import { homedir } from "os";
import { join } from "path";

import { CoreClient } from "./core";
import { createControlClient, createDataClient, createIamClient } from "./core/factories";
import { createRootHandler } from "./handlers";
import { createFileLogger, LOG_LEVEL } from "./logging";
import { runWithExitCode } from "./runnable";

process.exit(
  await runWithExitCode(async (argv: string[]) => {
    // generate a unique identifier corresponding to this process of this CLI. (ex. one command invoke, one TUI session)
    // TODO: wire this id into telemetry as well
    const cliSessionId = crypto.randomUUID();

    const rootLogger = createFileLogger({
      filePath: join(homedir(), ".agentcore", "logs", "output"),
      // TODO: allow overriding via global settings
      logLevel: LOG_LEVEL.DEBUG,
      bindings: { cliSessionId },
    });

    const io = {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    };

    try {
      // Wrap the SDK clients in the CoreClient the handlers consume. Passing
      // factories (rather than instances) lets CoreClient build one client per
      // region on demand.
      const coreClient = new CoreClient(createControlClient, createDataClient, createIamClient);

      // Pass it to the root handler, along with the process's standard streams as
      // the app's io. CoreClient exposes feature sub-clients (e.g. `.harness`), so
      // it satisfies the Core contract directly.
      const rootHandler = createRootHandler(coreClient, {
        io,
        logger: rootLogger,
      });

      // Handle the request
      await rootHandler.route(argv);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      rootLogger
        .child({ errorName: error.name, errorMessage: error.message, stack: error.stack ?? "" })
        .error();
      throw e;
    } finally {
      await rootLogger.end();
    }
  }),
);
