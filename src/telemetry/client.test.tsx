import { test, describe, beforeEach, afterEach, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DefaultTelemetryClient } from "./client";
import { TelemetryAttributesRecorder } from "./recorder";
import { createFileLogger, type Logger } from "../logging";
import { LOG_LEVEL } from "../logging";
import { assertLogsMatch, TestGlobalConfigAccessor } from "../testing";
import type { MetricSink } from "./types";
import { LoggingSink } from "./loggingSink";

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

  test("emits metrics with resource and command attributes to configured sinks", async () => {
    const sink = new LoggingSink({ logger: logger.child({ module: "loggingSink" }) });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const globalConfigAccessor = new TestGlobalConfigAccessor();
    const client = new DefaultTelemetryClient({
      logger,
      sessionId,
      globalConfigAccessor,
      metricSinks: [sink],
    });

    const recorder = new TelemetryAttributesRecorder("cli.command_run", { exit_reason: "success" });

    recorder.record({ exit_reason: "failure" });

    await client.emit("cli.command_run", 123, recorder.getAttributes());

    expect(sink.getName()).toBe("LoggingSink");
    await sink.shutdown();
    await client.shutdown();

    const { installationId } = await globalConfigAccessor.get();
    await assertLogsMatch(tempDir, [
      {
        filter: (log: any) =>
          log.metricName === "cli.command_run" &&
          log.metricValue === 123 &&
          log.metricAttributes?.["exit_reason"] === "failure" &&
          log.metricAttributes?.["service.name"] === "agentcore-cli" &&
          log.metricAttributes?.["agentcore-cli.session_id"] === sessionId &&
          log.metricAttributes?.["agentcore-cli.installation_id"] === installationId,
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
