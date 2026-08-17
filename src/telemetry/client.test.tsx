import { test, describe, beforeEach, afterEach, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { DefaultTelemetryClient } from "./client";
import { createFileLogger, type Logger } from "../logging";
import { LOG_LEVEL } from "../logging";
import { assertLogsMatch, createSilentLogger, TestGlobalConfigAccessor } from "../testing";
import type { MetricSink } from "./types";
import { FileSystemSink } from "./fileSystemSink";
import { DEFAULT_GLOBAL_CONFIG } from "../globalConfig";
import { PACKAGE_VERSION } from "../constants";

describe("DefaultTelemetryClient", () => {
  let tempDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "telemetry-client-test-"));
    logger = createFileLogger({
      filePath: join(tempDir, "output.log"),
      logLevel: LOG_LEVEL.DEBUG,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("emits complete metrics to configured JSONL filesystem sinks", async () => {
    const auditFilePath = join(tempDir, "telemetry", "audit.jsonl");
    const sinkResourceAttributes = {
      "service.name": "agentcore-cli" as const,
      "service.version": "0.0.0",
      "agentcore-cli.installation_id": "00000000-0000-0000-0000-000000000000",
      "agentcore-cli.session_id": "00000000-0000-0000-0000-000000000000",
      "os.type": os.type(),
      "os.version": os.release(),
      "host.arch": os.arch(),
      "node.version": process.version,
    };
    const fileSystemSink = new FileSystemSink({
      logger: logger.child({ module: "fileSystemSink" }),
      filePath: auditFilePath,
      resourceAttributes: sinkResourceAttributes,
    });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const globalConfigAccessor = new TestGlobalConfigAccessor();
    const client = new DefaultTelemetryClient({
      logger,
      sessionId,
      globalConfigAccessor,
      metricSinks: [fileSystemSink],
    });

    const metricEvent = client.createMetricEvent("cli.command_run", {
      exit_reason: "success",
      command_path: "/agentcore",
    });

    await metricEvent.emit(123);

    // create a second event with failure
    const metricEvent2 = client.createMetricEvent("cli.command_run", {
      exit_reason: "failure",
      command_path: "/agentcore",
    });

    await metricEvent2.emit(456);
    await client.shutdown();

    expect(fileSystemSink.getName()).toBe("FileSystemSink");

    const auditContents = await readFile(auditFilePath, "utf8");

    const entries = auditContents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries).toEqual([
      {
        metricName: "cli.command_run",
        value: 123,
        attrs: {
          ...sinkResourceAttributes,
          exit_reason: "success",
          command_path: "/agentcore",
          is_tui: false,
        },
      },
      {
        metricName: "cli.command_run",
        value: 456,
        attrs: {
          ...sinkResourceAttributes,
          exit_reason: "failure",
          command_path: "/agentcore",
          is_tui: false,
        },
      },
    ]);
  });

  test("enables the default audit sink only when global config audit is enabled", async () => {
    const auditFilePath = join(tempDir, "telemetry", "config-audit.jsonl");
    const enabledSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const disabledSessionId = "ffffffff-1111-2222-3333-444444444444";

    const enabledConfigAccessor = new TestGlobalConfigAccessor();
    const enabledConfig = await enabledConfigAccessor.get();
    await enabledConfigAccessor.set({
      ...enabledConfig,
      telemetry: { ...enabledConfig.telemetry, audit: true },
    });

    const disabledConfigAccessor = new TestGlobalConfigAccessor();
    const disabledConfig = await disabledConfigAccessor.get();
    await disabledConfigAccessor.set({
      ...disabledConfig,
      telemetry: { ...disabledConfig.telemetry, audit: false },
    });

    const enabledClient = new DefaultTelemetryClient({
      logger,
      sessionId: enabledSessionId,
      globalConfigAccessor: enabledConfigAccessor,
      auditFilePath,
    });
    const disabledClient = new DefaultTelemetryClient({
      logger,
      sessionId: disabledSessionId,
      globalConfigAccessor: disabledConfigAccessor,
      auditFilePath,
    });

    const enabledEvent = enabledClient.createMetricEvent("cli.command_run", {
      exit_reason: "success",
      command_path: "/agentcore",
      is_tui: true,
    });
    await enabledEvent.emit(123);

    const disabledEvent = disabledClient.createMetricEvent("cli.command_run", {
      exit_reason: "failure",
      command_path: "/agentcore",
      is_tui: false,
    });
    await disabledEvent.emit(123);

    await Promise.all([enabledClient.shutdown(), disabledClient.shutdown()]);

    const auditLines = (await readFile(auditFilePath, "utf8")).trimEnd().split("\n");
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0]!)).toEqual({
      metricName: "cli.command_run",
      value: 123,
      attrs: {
        "service.name": "agentcore-cli",
        "service.version": PACKAGE_VERSION,
        "agentcore-cli.installation_id": enabledConfig.installationId,
        "agentcore-cli.session_id": enabledSessionId,
        "os.type": os.type(),
        "os.version": os.release(),
        "host.arch": os.arch(),
        "node.version": process.version,
        exit_reason: "success",
        command_path: "/agentcore",
        is_tui: true,
      },
    });
  });

  test("throws when metric event has incomplete attributes", async () => {
    const client = new DefaultTelemetryClient({
      logger,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      metricSinks: [],
    });

    const metricEvent = client.createMetricEvent("cli.command_run");

    await expect(metricEvent.emit(100)).rejects.toThrow();
    await client.shutdown();
  });

  test("FileSystemSink logs a warning when the file is not writable", async () => {
    // Point the sink at a directory to trigger EISDIR
    const sink = new FileSystemSink({
      logger: logger.child({ module: "fileSystemSink" }),
      filePath: tempDir,
      resourceAttributes: {
        "service.name": "agentcore-cli",
        "service.version": "0.0.0",
        "agentcore-cli.installation_id": "00000000-0000-0000-0000-000000000000",
        "agentcore-cli.session_id": "00000000-0000-0000-0000-000000000000",
        "os.type": os.type(),
        "os.version": os.release(),
        "host.arch": os.arch(),
        "node.version": process.version,
      },
    });

    const client = new DefaultTelemetryClient({
      logger,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      metricSinks: [sink],
    });
    const metricEvent = client.createMetricEvent("cli.command_run", {
      exit_reason: "success",
      command_path: "/agentcore",
    });
    await metricEvent.emit(1);
    await client.shutdown();

    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.msg === "failed to append metric data to file" &&
          log.errorMessage?.includes("EISDIR"),
        expectedCount: 1,
      },
    ]);
  });

  test("handles sink errors gracefully without throwing", async () => {
    const recordedMetrics: string[] = [];
    const goodSink: MetricSink = {
      getName: () => "GoodSink",
      send: (metricName) => {
        recordedMetrics.push(metricName);
      },
      shutdown: async () => {},
    };

    const badSink: MetricSink = {
      getName: () => "BadSink",
      send: () => {
        throw new Error("record exploded");
      },
      shutdown: async () => {
        throw new Error("shutdown exploded");
      },
    };

    const client = new DefaultTelemetryClient({
      logger,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      metricSinks: [badSink, goodSink],
    });

    const metricEvent = client.createMetricEvent("cli.command_run", {
      exit_reason: "success",
      command_path: "/agentcore",
    });

    // end should not throw even though the sink's send() throws
    await metricEvent.emit(100);
    // shutdown should not throw even though the sink's shutdown() rejects
    await client.shutdown();

    // GoodSink still receives data despite BadSink throwing
    expect(recordedMetrics).toEqual(["cli.command_run"]);

    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.msg === "failed to record to sink 'BadSink'" &&
          log.errorName === "Error" &&
          log.errorMessage === "record exploded",
        expectedCount: 1,
      },
      {
        filter: (log: any) =>
          log.msg === "failed to shutdown metric sink with name 'BadSink'" &&
          log.errorName === "Error" &&
          log.errorMessage === "shutdown exploded",
        expectedCount: 1,
      },
    ]);
  });
});

describe("OtelHistogramSink", () => {
  let testCollector: ReturnType<typeof Bun.serve>;
  let receivedBodies: any[];

  const logger = createSilentLogger();

  beforeEach(async () => {
    receivedBodies = [];
    testCollector = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        receivedBodies.push(body);
        return new Response("", { status: 200 });
      },
    });
  });

  afterEach(async () => {
    testCollector.stop(true);
  });

  test.each([
    { enabled: true, expectRequests: true },
    { enabled: false, expectRequests: false },
  ])(
    "telemetry.enabled=$enabled → collector receives requests=$expectRequests",
    async ({ enabled, expectRequests }) => {
      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const exitReason = "success";
      const commandPath = "/agentcore";
      const metricName = "cli.command_run";
      const scopeName = "agentcore-cli";
      const serviceName = "agentcore-cli";
      const globalConfigAccessor = new TestGlobalConfigAccessor({
        initialConfigData: {
          ...DEFAULT_GLOBAL_CONFIG,
          telemetry: {
            enabled,
            audit: false,
            endpoint: `http://localhost:${testCollector.port}`,
          },
        },
      });

      const client = new DefaultTelemetryClient({
        logger,
        sessionId,
        globalConfigAccessor,
      });

      const event = client.createMetricEvent(metricName, {
        exit_reason: exitReason,
        command_path: commandPath,
      });
      await event.emit(100);
      await client.shutdown();

      if (expectRequests) {
        expect(receivedBodies.length).toBeGreaterThan(0);

        const body = receivedBodies[0];
        expect(body).toMatchObject({
          resourceMetrics: [
            {
              resource: {
                attributes: expect.arrayContaining([
                  { key: "service.name", value: { stringValue: serviceName } },
                  {
                    key: "agentcore-cli.session_id",
                    value: { stringValue: sessionId },
                  },
                  { key: "os.type", value: { stringValue: os.type() } },
                  { key: "host.arch", value: { stringValue: os.arch() } },
                ]),
              },
              scopeMetrics: [
                {
                  scope: { name: scopeName },
                  metrics: [
                    {
                      name: metricName,
                      histogram: {
                        dataPoints: [
                          {
                            attributes: expect.arrayContaining([
                              { key: "exit_reason", value: { stringValue: exitReason } },
                              { key: "command_path", value: { stringValue: commandPath } },
                            ]),
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        });
      } else {
        expect(receivedBodies).toHaveLength(0);
      }
    },
  );
});
