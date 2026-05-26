import { createTelemetryHelper, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('status command', () => {
  let testDir: string;
  let projectDir: string;
  const telemetry = createTelemetryHelper();

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-status-telemetry-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const projectName = 'StatusTelemetryProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterEach(() => {
    telemetry.clearEntries();
  });

  afterAll(async () => {
    telemetry.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  it('emits success telemetry for basic status', async () => {
    const result = await runCLI(['status', '--json'], projectDir, { env: telemetry.env });
    expect(result.exitCode).toBe(0);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'success',
      filter_type: 'none',
      filter_state: 'none',
    });
  });

  it('emits success telemetry with filter attrs', async () => {
    const result = await runCLI(['status', '--type', 'agent', '--state', 'deployed', '--json'], projectDir, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(0);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'success',
      filter_type: 'agent',
      filter_state: 'deployed',
    });
  });

  it('emits success telemetry for runtime-endpoint filter', async () => {
    const result = await runCLI(['status', '--type', 'runtime-endpoint', '--json'], projectDir, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(0);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'success',
      filter_type: 'runtime-endpoint',
    });
  });

  it('emits failure telemetry for invalid --type', async () => {
    const result = await runCLI(['status', '--type', 'bogus'], projectDir, { env: telemetry.env });
    expect(result.exitCode).toBe(0);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'failure',
      filter_type: 'unknown',
      filter_state: 'none',
    });
  });

  it('emits failure telemetry for invalid --state', async () => {
    const result = await runCLI(['status', '--state', 'bogus'], projectDir, { env: telemetry.env });
    expect(result.exitCode).toBe(0);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'failure',
      filter_type: 'none',
      filter_state: 'unknown',
    });
  });

  it('emits failure telemetry for nonexistent target', async () => {
    const result = await runCLI(['status', '--target', 'nonexistent', '--json'], projectDir, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'failure',
      filter_type: 'none',
      filter_state: 'none',
    });
  });

  it('emits failure telemetry for --runtime-id lookup', async () => {
    const result = await runCLI(['status', '--runtime-id', 'fake-id', '--json'], projectDir, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    telemetry.assertMetricEmitted({
      command: 'status',
      exit_reason: 'failure',
    });
  });
});
