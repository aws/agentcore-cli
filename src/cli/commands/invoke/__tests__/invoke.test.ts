import { createTelemetryHelper, runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('invoke command', () => {
  let testDir: string;
  let projectDir: string;
  const telemetry = createTelemetryHelper();

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-invoke-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent
    const projectName = 'InvokeTestProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add an agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'TestAgent',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create agent: ${result.stdout} ${result.stderr}`);
    }
  });

  afterEach(() => {
    telemetry.clearEntries();
  });

  afterAll(async () => {
    telemetry.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires prompt for JSON output', async () => {
      const result = await runCLI(['invoke', '--json'], projectDir, { env: telemetry.env });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('Prompt'), `Error should mention Prompt: ${json.error}`).toBeTruthy();
      telemetry.assertMetricEmitted({
        command: 'invoke',
        exit_reason: 'failure',
        has_stream: false,
        has_session_id: false,
        auth_type: 'sigv4',
      });
    });
  });

  describe('agent validation', () => {
    it('rejects non-existent agent', async () => {
      const result = await runCLI(['invoke', 'hello', '--runtime', 'nonexistent', '--json'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.includes('not found') || json.error.includes('No deployed'),
        `Error should mention not found: ${json.error}`
      ).toBeTruthy();
      telemetry.assertMetricEmitted({
        command: 'invoke',
        exit_reason: 'failure',
        protocol: 'http',
        auth_type: 'sigv4',
        has_session_id: false,
      });
    });
  });

  describe('streaming', () => {
    it('command accepts --stream flag', async () => {
      const result = await runCLI(['invoke', 'hello', '--stream', '--json'], projectDir, { env: telemetry.env });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      // Should fail because not deployed, not because of invalid flags
      telemetry.assertMetricEmitted({
        command: 'invoke',
        has_stream: true,
        exit_reason: 'failure',
        auth_type: 'sigv4',
        has_session_id: false,
      });
    });

    it('--stream with invalid agent returns error', async () => {
      const result = await runCLI(['invoke', 'hello', '--stream', '--runtime', 'nonexistent', '--json'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.length > 0, 'Should have error message').toBeTruthy();
      telemetry.assertMetricEmitted({
        command: 'invoke',
        has_stream: true,
        exit_reason: 'failure',
        auth_type: 'sigv4',
      });
    });

    it('requires prompt for streaming', async () => {
      const result = await runCLI(['invoke', '--stream', '--json'], projectDir, { env: telemetry.env });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('prompt') || json.error.toLowerCase().includes('deploy'),
        `Error should mention prompt or deployment: ${json.error}`
      ).toBeTruthy();
      telemetry.assertMetricEmitted({
        command: 'invoke',
        has_stream: true,
        exit_reason: 'failure',
        auth_type: 'sigv4',
        has_session_id: false,
      });
    });
  });

  describe('bearer token auth', () => {
    it('records auth_type bearer_token', async () => {
      const result = await runCLI(['invoke', 'hello', '--bearer-token', 'fake-token', '--json'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      telemetry.assertMetricEmitted({
        command: 'invoke',
        auth_type: 'bearer_token',
        exit_reason: 'failure',
      });
    });
  });

  describe('session id', () => {
    it('records has_session_id true', async () => {
      const result = await runCLI(['invoke', 'hello', '--session-id', 'test-session', '--json'], projectDir, {
        env: telemetry.env,
      });
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      telemetry.assertMetricEmitted({
        command: 'invoke',
        has_session_id: true,
        exit_reason: 'failure',
        auth_type: 'sigv4',
      });
    });
  });
});
