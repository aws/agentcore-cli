import { createTelemetryHelper, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('import command', () => {
  let testDir: string;
  let projectDir: string;
  const telemetry = createTelemetryHelper();

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-import-telemetry-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const projectName = 'ImportTelemetryProj';
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

  describe('import --source', () => {
    it('emits failure telemetry for nonexistent source file', async () => {
      const result = await runCLI(['import', '--source', '/nonexistent/file.yaml'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import',
        exit_reason: 'failure',
      });
    });
  });

  describe('import runtime', () => {
    it('emits failure telemetry for invalid ARN', async () => {
      const result = await runCLI(['import', 'runtime', '--arn', 'invalid-arn'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import.runtime',
        exit_reason: 'failure',
      });
    });
  });

  describe('import memory', () => {
    it('emits failure telemetry for invalid ARN', async () => {
      const result = await runCLI(['import', 'memory', '--arn', 'invalid-arn'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import.memory',
        exit_reason: 'failure',
      });
    });
  });

  describe('import evaluator', () => {
    it('emits failure telemetry for invalid ARN', async () => {
      const result = await runCLI(['import', 'evaluator', '--arn', 'invalid-arn'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import.evaluator',
        exit_reason: 'failure',
      });
    });
  });

  describe('import gateway', () => {
    it('emits failure telemetry for invalid ARN', async () => {
      const result = await runCLI(['import', 'gateway', '--arn', 'invalid-arn'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import.gateway',
        exit_reason: 'failure',
      });
    });
  });

  describe('import online-eval', () => {
    it('emits failure telemetry for invalid ARN', async () => {
      const result = await runCLI(['import', 'online-eval', '--arn', 'invalid-arn'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({
        command: 'import.online-eval',
        exit_reason: 'failure',
      });
    });
  });
});
