import { test, describe, beforeEach, afterEach } from "bun:test";
import z from "zod";
import { Router, createHandler, flag } from "../router";
import { withLogging } from "./withLogging";
import { withFeatureFlags } from "./withFeatureFlags";
import { createFileLogger } from "../logging/fileLogger";
import { LOG_LEVEL, type AsyncLogger } from "../logging/types";
import { assertLogsMatch, TestFeatureFlags } from "../testing";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("withLogging", () => {
  let tempDir: string;
  let logger: AsyncLogger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "logging-test-"));
    logger = createFileLogger({
      filePath: join(tempDir, "output"),
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

  // A debug log of a run has to answer "which experiments were on"; the line is
  // written only when one is, so unflagged runs keep their existing log shape.
  test("names the enabled feature flags once per command", async () => {
    const app = new Router("myapp", "test app");
    app.use(withFeatureFlags(new TestFeatureFlags(["imperativeDeploy"])));
    app.use(withLogging({ logger }));
    app.handler(createHandler({ name: "flagged", description: "runs", handle: async () => {} }));

    await app.route(["node", "myapp", "flagged"]);

    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.msg === "experimental feature flags enabled" &&
          log.featureFlags?.length === 1 &&
          log.featureFlags[0] === "imperativeDeploy" &&
          log.commandPath === "/myapp/flagged",
        expectedCount: 1,
      },
    ]);
  });

  test("writes no feature-flag line when nothing is enabled", async () => {
    const app = new Router("myapp", "test app");
    app.use(withFeatureFlags(new TestFeatureFlags()));
    app.use(withLogging({ logger }));
    app.handler(createHandler({ name: "plain", description: "runs", handle: async () => {} }));

    await app.route(["node", "myapp", "plain"]);

    await assertLogsMatch(tempDir, [
      { filter: (log: any) => log.msg === "command executed successfully", expectedCount: 1 },
      { filter: (log: any) => log.msg === "experimental feature flags enabled", expectedCount: 0 },
    ]);
  });
});
