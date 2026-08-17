import { test, describe, beforeEach, afterEach } from "bun:test";
import z from "zod";
import { Router, createHandler, flag } from "../router";
import { withLogging } from "./withLogging";
import { createFileLogger } from "../logging/fileLogger";
import { LOG_LEVEL, type AsyncLogger } from "../logging/types";
import { assertLogsMatch } from "../testing";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("withLogging", () => {
  let tempDir: string;
  let logger: AsyncLogger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "logging-test-"));
    logger = createFileLogger({
      filePath: join(tempDir, "output.log"),
      logLevel: LOG_LEVEL.DEBUG,
    });
  });

  afterEach(async () => {
    await logger.end();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("redacts sensitive flags and preserves all non-sensitive flags", async () => {
    const app = new Router("myapp", "test app");
    app.use(withLogging({ logger }));
    app.handler(
      createHandler({
        name: "login",
        description: "login with credentials",
        flags: [
          flag("name", "the provider name", z.string().optional()),
          flag("api-key", "the secret key", z.string().optional(), { sensitive: true }),
        ],
        handle: async () => {},
      }),
    );

    await app.route([
      "node",
      "myapp",
      "login",
      "--name",
      "my-provider",
      "--api-key",
      "super-secret",
    ]);

    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.msg === "executing command" &&
          log.flags?.name === "my-provider" &&
          log.flags?.["api-key"] === "[REDACTED]",
        expectedCount: 1,
      },
    ]);
  });

  test("logs success with the correct command path binding", async () => {
    const app = new Router("myapp", "test app");
    app.use(withLogging({ logger }));
    app.handler(
      createHandler({
        name: "happy",
        description: "succeeds",
        handle: async () => {},
      }),
    );

    await app.route(["node", "myapp", "happy"]);

    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.msg === "command executed successfully" && log.commandPath === "/myapp/happy",
        expectedCount: 1,
      },
    ]);
  });
});
