import { expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { PACKAGE_VERSION } from "../constants";
import { AgentCoreCLIError } from "../errors/errors";
import { CommandRunMetricEventKey, type Context } from "../router";
import { DefaultTelemetryClient } from "../telemetry";
import { FileSystemSink } from "../telemetry/fileSystemSink";
import type { AttributesOf, MetricName, TelemetryClient } from "../telemetry/types";
import { TestGlobalConfigAccessor } from "./globalConfig";
import { createSilentLogger } from "./logging";

export async function getTestTelemetryClient() {
  const directory = await mkdtemp(join(os.tmpdir(), "agentcore-telemetry-"));
  const filePath = join(directory, "audit.jsonl");
  const logger = createSilentLogger();
  const sessionId = crypto.randomUUID();
  const client = new DefaultTelemetryClient({
    logger,
    sessionId,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    currentVersion: PACKAGE_VERSION,
    metricSinks: [
      new FileSystemSink({
        logger,
        filePath,
        resourceAttributes: {
          "service.name": "agentcore-cli",
          "service.version": PACKAGE_VERSION,
          "agentcore-cli.installation_id": "00000000-0000-0000-0000-000000000000",
          "agentcore-cli.session_id": sessionId,
          "os.type": os.type(),
          "os.version": os.release(),
          "host.arch": os.arch(),
          "node.version": process.version,
        },
      }),
    ],
  });
  return {
    client,
    filePath,
    cleanup: async () => {
      await client.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function assertMetricEmitted<TMetricName extends MetricName>(
  filePath: string,
  metricName: TMetricName,
  attributes: Partial<AttributesOf<TMetricName>> = {},
): Promise<void> {
  const entries = (await readFile(filePath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  expect(entries).toContainEqual(
    expect.objectContaining({
      metricName,
      value: expect.any(Number),
      attrs: expect.objectContaining(attributes),
    }),
  );
}

export async function withTelemetry<T>(
  ctx: Context,
  client: TelemetryClient,
  command: (ctx: Context) => Promise<T>,
): Promise<T> {
  const event = client.createMetricEvent("cli.command_run", { exit_reason: "success" });
  const startTime = Date.now();
  try {
    return await command(ctx.withValue(CommandRunMetricEventKey, event));
  } catch (cause) {
    const error = AgentCoreCLIError.fromError(cause);
    if (error.exitCode !== 0) {
      event.setAttributes({
        exit_reason: "failure",
        error_name: error.name,
        error_source: error.source,
      });
    }
    throw cause;
  } finally {
    try {
      await event.emit(Date.now() - startTime);
    } finally {
      await client.shutdown();
    }
  }
}
