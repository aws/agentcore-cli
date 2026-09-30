import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultGlobalConfigAccessor } from "./accessor";
import { FsReadWriteJson } from "../io";
import { createSilentLogger } from "../testing";

describe("DefaultGlobalConfigAccessor telemetry partition default", () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv = { ...process.env };

  const savedArgv = [...process.argv];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentcore-accessor-test-"));
    configPath = join(tempDir, "config.json");
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_PROFILE;
    // Point the shared-config fallback of the region resolution at a
    // nonexistent file so the host's real ~/.aws/config cannot leak in.
    process.env.AWS_CONFIG_FILE = join(tempDir, "no-aws-config");
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    process.argv = [...savedArgv];
    await rm(tempDir, { recursive: true, force: true });
  });

  function accessor() {
    const logger = createSilentLogger();
    return new DefaultGlobalConfigAccessor({
      logger,
      filePath: configPath,
      json: new FsReadWriteJson({ logger }),
    });
  }

  test("telemetry defaults to enabled outside the aws-cn partition", async () => {
    const config = await accessor().get();
    expect(config.telemetry.enabled).toBe(true);
  });

  test.each(["AWS_REGION", "AWS_DEFAULT_REGION"] as const)(
    "telemetry defaults to disabled when %s is a China region",
    async (envVar) => {
      process.env[envVar] = "cn-north-1";
      const config = await accessor().get();
      expect(config.telemetry.enabled).toBe(false);
    },
  );

  test("an explicit telemetry.enabled in the config file wins over the aws-cn default", async () => {
    process.env.AWS_REGION = "cn-north-1";
    await writeFile(configPath, JSON.stringify({ telemetry: { enabled: true } }));

    const config = await accessor().get();
    expect(config.telemetry.enabled).toBe(true);
  });

  test("a first run in a China region persists telemetry disabled", async () => {
    process.env.AWS_REGION = "cn-north-1";
    await accessor().get();

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.telemetry).toEqual({ enabled: false });

    // A later run in a commercial region keeps the persisted opt-out — the
    // first-run notice was never shown, so telemetry must not silently start.
    delete process.env.AWS_REGION;
    const config = await accessor().get();
    expect(config.telemetry.enabled).toBe(false);
    expect(config.isFirstRun).toBe(false);
  });

  test("a first commercial run persists only the installation id", async () => {
    await accessor().get();

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.telemetry).toBeUndefined();
    expect(persisted.installationId).toBeDefined();
  });

  test("a first run with China only from --region persists telemetry disabled", async () => {
    process.argv = ["node", "agentcore", "runtime", "list", "--region", "cn-north-1"];
    await accessor().get();

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.telemetry).toEqual({ enabled: false });
  });

  test("a first run with China only from the active profile persists telemetry disabled", async () => {
    const awsConfigPath = join(tempDir, "aws-config");
    await writeFile(awsConfigPath, "[default]\nregion = cn-northwest-1\n");
    process.env.AWS_CONFIG_FILE = awsConfigPath;

    const config = await accessor().get();
    expect(config.telemetry.enabled).toBe(false);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.telemetry).toEqual({ enabled: false });
  });

  test("a first China run does not clobber a pre-seeded explicit opt-in", async () => {
    process.env.AWS_REGION = "cn-north-1";
    await writeFile(configPath, JSON.stringify({ telemetry: { enabled: true } }));

    await accessor().get();
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.telemetry.enabled).toBe(true);
  });
});
