import { test, describe, beforeEach, afterEach, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { DefaultTelemetryClient } from "./client";
import { TelemetryAttributesRecorder } from "./recorder";
import { createFileLogger, type Logger } from "../logging";
import { LOG_LEVEL } from "../logging";
import { assertLogsMatch, TestGlobalConfigAccessor } from "../testing";
import type { MetricSink } from "./types";
import { LoggingSink } from "./loggingSink";
import { FileSystemSink } from "./fileSystemSink";

describe("DefaultTelemetryClient", () => {
  let tempDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "telemetry-client-test-"));
    logger = createFileLogger({
      filePath: join(tempDir, "output"),
      logLevel: LOG_LEVEL.DEBUG,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("emits complete metrics to configured logging and JSONL filesystem sinks", async () => {
    const loggingSink = new LoggingSink({ logger: logger.child({ module: "loggingSink" }) });
    const auditFilePath = join(tempDir, "telemetry", "audit.jsonl");
    const fileSystemSink = new FileSystemSink({
      logger: logger.child({ module: "fileSystemSink" }),
      filePath: auditFilePath,
    });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const globalConfigAccessor = new TestGlobalConfigAccessor();
    const client = new DefaultTelemetryClient({
      logger,
      sessionId,
      globalConfigAccessor,
      metricSinks: [loggingSink, fileSystemSink],
    });

    const recorder = new TelemetryAttributesRecorder("cli.command_run", { exit_reason: "success" });

    await client.emit("cli.command_run", 123, recorder.getAttributes());

    recorder.record({ exit_reason: "failure" });
    await client.emit("cli.command_run", 456, recorder.getAttributes());
    await client.shutdown();

    expect(loggingSink.getName()).toBe("LoggingSink");
    expect(fileSystemSink.getName()).toBe("FileSystemSink");

    const { installationId } = await globalConfigAccessor.get();
    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.metricName === "cli.command_run" &&
          log.metricValue === 123 &&
          log.metricAttributes?.["exit_reason"] === "success" &&
          log.metricAttributes?.["service.name"] === "agentcore-cli" &&
          log.metricAttributes?.["agentcore-cli.session_id"] === sessionId &&
          log.metricAttributes?.["agentcore-cli.installation_id"] === installationId,
        expectedCount: 1,
      },
      {
        filter: (log: any) =>
          log.metricName === "cli.command_run" &&
          log.metricValue === 456 &&
          log.metricAttributes?.["exit_reason"] === "failure" &&
          log.metricAttributes?.["service.name"] === "agentcore-cli" &&
          log.metricAttributes?.["agentcore-cli.session_id"] === sessionId &&
          log.metricAttributes?.["agentcore-cli.installation_id"] === installationId,
        expectedCount: 1,
      },
    ]);

    const auditContents = await readFile(auditFilePath, "utf8");
    expect(auditContents.endsWith("\n")).toBe(true);

    const entries = auditContents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    const resourceAttributes = {
      "service.name": "agentcore-cli",
      "service.version": "0.0.0",
      "agentcore-cli.installation_id": installationId,
      "agentcore-cli.session_id": sessionId,
      "os.type": os.type(),
      "os.version": os.release(),
      "host.arch": os.arch(),
      "node.version": process.version,
    };

    expect(entries).toEqual([
      {
        metricName: "cli.command_run",
        value: 123,
        attrs: { ...resourceAttributes, exit_reason: "success" },
      },
      {
        metricName: "cli.command_run",
        value: 456,
        attrs: { ...resourceAttributes, exit_reason: "failure" },
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

    await enabledClient.emit("cli.command_run", 123, { exit_reason: "success" });
    await disabledClient.emit("cli.command_run", 456, { exit_reason: "failure" });
    await Promise.all([enabledClient.shutdown(), disabledClient.shutdown()]);

    const auditLines = (await readFile(auditFilePath, "utf8")).trimEnd().split("\n");
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0]!)).toEqual({
      metricName: "cli.command_run",
      value: 123,
      attrs: {
        "service.name": "agentcore-cli",
        "service.version": "0.0.0",
        "agentcore-cli.installation_id": enabledConfig.installationId,
        "agentcore-cli.session_id": enabledSessionId,
        "os.type": os.type(),
        "os.version": os.release(),
        "host.arch": os.arch(),
        "node.version": process.version,
        exit_reason: "success",
      },
    });
  });

  test("throws when recorder has incomplete attributes", async () => {
    const client = new DefaultTelemetryClient({
      logger,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      metricSinks: [],
    });

    const recorder = new TelemetryAttributesRecorder("cli.command_run");

    expect(() => client.emit("cli.command_run", 100, recorder.getAttributes())).toThrow();
    await client.shutdown();
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

    // emit should not throw even though the sink's record() throws
    await client.emit("cli.command_run", 100, { exit_reason: "success" });
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
