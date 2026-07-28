import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../testing";
import { DefaultGlobalConfigAccessor } from "../../globalConfig";
import { InputValidationError } from "../../errors";
import { FsReadWriteJson } from "../../io";
import { InputValidationError } from "../../errors";

describe("config", () => {
  let tempDir: string;
  let configPath: string;

  const validConfigOverrides = {
    telemetry: { enabled: true, endpoint: "https://example.com" },
    installationId: "550e8400-e29b-41d4-a716-446655440000",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentcore-config-test-"));
    configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(validConfigOverrides));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    const io = testIO();
    const logger = createSilentLogger();
    const globalConfigAccessor = new DefaultGlobalConfigAccessor({
      logger,
      filePath: configPath,
      json: new FsReadWriteJson({
        logger,
      }),
    });
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger,
      globalConfigAccessor,
    });
    await root.route(["node", "agentcore", "config", ...args]);
    return io.stdout();
  }

  test("prints the full config when no args are passed", async () => {
    const output = await run([]);
    expect(JSON.parse(output)).toMatchObject(validConfigOverrides);
  });

  test("prints the value at a key when only a key is passed", async () => {
    const output = await run(["telemetry.enabled"]);
    expect(JSON.parse(output)).toBe(true);
  });

  test("prints a nested object when a branch key is passed", async () => {
    const output = await run(["telemetry"]);
    expect(JSON.parse(output)).toMatchObject(validConfigOverrides.telemetry);
  });

  test("sets a value when key and value are passed", async () => {
    const initialReadValueOutput = await run(["telemetry.endpoint"]);
    expect(JSON.parse(initialReadValueOutput)).toBe(validConfigOverrides.telemetry.endpoint);

    const newEndpoint = "http://example2.com";

    const writeValueOutput = await run(["telemetry.endpoint", newEndpoint]);
    expect(JSON.parse(writeValueOutput)).toBe(newEndpoint);

    const readValueOutput = await run(["telemetry.endpoint"]);
    expect(JSON.parse(readValueOutput)).toBe(newEndpoint);
  });

  test("accepts json values for non-leaf nodes", async () => {
    const initialTelemetrySettingsOutput = await run(["telemetry"]);
    const initialTelemetrySettings = JSON.parse(initialTelemetrySettingsOutput);

    // flip telemetry.enabled via json notation input
    const newTelemetrySettings = {
      ...initialTelemetrySettings,
      enabled: !initialTelemetrySettings.enabled,
    };

    const newTelemetrySettingsOutput = await run([
      "telemetry",
      JSON.stringify(newTelemetrySettings),
    ]);
    expect(JSON.parse(newTelemetrySettingsOutput)).toMatchObject(newTelemetrySettings);

    const finalTelemetrySettingsOutput = await run(["telemetry"]);
    expect(JSON.parse(finalTelemetrySettingsOutput)).toMatchObject(newTelemetrySettings);
  });

  test("throws on invalid key", async () => {
    await expect(run(["nonexistent.key"])).rejects.toThrow(InputValidationError);
  });

  test("throws on invalid value for key", async () => {
    await expect(run(["telemetry.enabled", "banana"])).rejects.toThrow(InputValidationError);
  });

  test("coerces values based on schema", async () => {
    const setEnabledOutput = await run(["telemetry.enabled", "false"]);
    expect(JSON.parse(setEnabledOutput)).toBe(false);
    const readEnabledOutput = await run(["telemetry.enabled"]);
    expect(JSON.parse(readEnabledOutput)).toBe(false);

    const setEndpointOutput = await run(["telemetry.endpoint", "false"]);
    expect(JSON.parse(setEndpointOutput)).toBe("false");
    const readEndpointOutput = await run(["telemetry.endpoint"]);
    expect(JSON.parse(readEndpointOutput)).toBe("false");
  });

  test("throws if any field fails validation", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        telemetry: { enabled: "not-a-bool", endpoint: "https://good.com" },
      }),
    );
    await expect(run(["telemetry.endpoint"])).rejects.toThrow("Failed to deserialize");
  });

  test("ignores unsupported fields in the config file", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfigOverrides,
        futureField: "unknown",
        telemetry: { ...validConfigOverrides.telemetry, futureNested: 42 },
      }),
    );
    const output = await run([]);
    expect(JSON.parse(output)).toMatchObject(validConfigOverrides);
  });

  test("throws clear error on invalid json", async () => {
    await writeFile(configPath, "not { valid json");
    // TODO: assert on error type
    await expect(run([])).rejects.toThrow("Failed to deserialize");
  });

  test("creates an override config if it does not exist", async () => {
    await rm(configPath);
    const newEndpoint = "http://new-endpoint.command";

    const output = await run(["telemetry.endpoint", newEndpoint]);
    expect(JSON.parse(output)).toBe(newEndpoint);

    const readOutput = await run(["telemetry.endpoint"]);
    expect(JSON.parse(readOutput)).toBe(newEndpoint);
  });

  test("writes installationId when config missing, preserves it when present", async () => {
    await rm(configPath);
    const firstOutput = await run(["installationId"]);
    const firstId = JSON.parse(firstOutput);
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);

    const secondOutput = await run(["installationId"]);
    expect(JSON.parse(secondOutput)).toBe(firstId);
  });

  test("writes installationId when config exists but installationId is missing", async () => {
    await writeFile(configPath, JSON.stringify({ telemetry: { enabled: true } }));

    const firstOutput = await run(["installationId"]);
    const firstId = JSON.parse(firstOutput);

    const secondOutput = await run(["installationId"]);
    expect(JSON.parse(secondOutput)).toBe(firstId);
  });

  test("creates the config directory if it does not exist", async () => {
    await rm(tempDir, { recursive: true, force: true });

    const output = await run(["telemetry.enabled", "false"]);
    expect(JSON.parse(output)).toBe(false);

    const readOutput = await run(["telemetry.enabled"]);
    expect(JSON.parse(readOutput)).toBe(false);
  });
});
