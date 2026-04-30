import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

describe('integration: add and remove resources', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  afterAll(async () => {
    await project.cleanup();
    telemetry.destroy();
  });

  describe('memory lifecycle', () => {
    const memoryName = `IntegMem${Date.now().toString().slice(-6)}`;

    it('adds a memory resource', async () => {
      const result = await runCLI(['add', 'memory', '--name', memoryName, '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const memories = config.memories as Record<string, unknown>[] | undefined;
      expect(memories, 'memories should exist').toBeDefined();
      const found = memories!.some((m: Record<string, unknown>) => m.name === memoryName);
      expect(found, `Memory "${memoryName}" should be in config`).toBe(true);

      telemetry.assertMetricEmitted({ command: 'add.memory', exit_reason: 'success' });
    });

    it('adds a memory with EPISODIC strategy and verifies reflectionNamespaces', async () => {
      const episodicMemName = `EpiMem${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        ['add', 'memory', '--name', episodicMemName, '--strategies', 'EPISODIC', '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify EPISODIC in config with reflectionNamespaces
      const config = await readProjectConfig(project.projectPath);
      const memories = config.memories as {
        name: string;
        strategies: { type: string; reflectionNamespaces?: string[] }[];
      }[];
      const mem = memories.find(m => m.name === episodicMemName);
      expect(mem, 'Memory should exist').toBeTruthy();

      const episodic = mem!.strategies.find(s => s.type === 'EPISODIC');
      expect(episodic, 'EPISODIC strategy should exist').toBeTruthy();
      expect(episodic!.reflectionNamespaces, 'Should have reflectionNamespaces').toBeDefined();
      expect(episodic!.reflectionNamespaces!.length).toBeGreaterThan(0);

      telemetry.assertMetricEmitted({
        command: 'add.memory',
        exit_reason: 'success',
        strategy_count: '1',
        strategy_episodic: 'true',
      });

      // Clean up
      await runCLI(['remove', 'memory', '--name', episodicMemName, '--json'], project.projectPath);
    });

    it('removes the memory resource', async () => {
      const result = await runCLI(['remove', 'memory', '--name', memoryName, '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const memories = (config.memories as Record<string, unknown>[] | undefined) ?? [];
      const found = memories.some((m: Record<string, unknown>) => m.name === memoryName);
      expect(found, `Memory "${memoryName}" should be removed from config`).toBe(false);

      telemetry.assertMetricEmitted({ command: 'remove.memory', exit_reason: 'success' });
    });
  });

  describe('credential lifecycle', () => {
    const credentialName = `IntegId${Date.now().toString().slice(-6)}`;

    it('adds a credential resource', async () => {
      const result = await runCLI(
        ['add', 'credential', '--name', credentialName, '--api-key', 'test-key-integ-123', '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const credentials = config.credentials as Record<string, unknown>[] | undefined;
      expect(credentials, 'credentials should exist').toBeDefined();
      const found = credentials!.some((c: Record<string, unknown>) => c.name === credentialName);
      expect(found, `Credential "${credentialName}" should be in config`).toBe(true);

      telemetry.assertMetricEmitted({
        command: 'add.credential',
        exit_reason: 'success',
        credential_type: 'api-key',
      });
    });

    it('removes the credential resource', async () => {
      const result = await runCLI(['remove', 'credential', '--name', credentialName, '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const credentials = (config.credentials as Record<string, unknown>[] | undefined) ?? [];
      const found = credentials.some((c: Record<string, unknown>) => c.name === credentialName);
      expect(found, `Credential "${credentialName}" should be removed from config`).toBe(false);

      telemetry.assertMetricEmitted({ command: 'remove.credential', exit_reason: 'success' });
    });
  });

  describe('policy-engine', () => {
    const engineName = `TestEngine${Date.now().toString().slice(-6)}`;

    it('adds a policy engine resource', async () => {
      const result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      telemetry.assertMetricEmitted({
        command: 'add.policy-engine',
        exit_reason: 'success',
        attach_gateway_count: '0',
      });
    });

    it('removes the policy engine resource', async () => {
      const result = await runCLI(['remove', 'policy-engine', '--name', engineName, '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      telemetry.assertMetricEmitted({ command: 'remove.policy-engine', exit_reason: 'success' });
    });
  });

  describe('remove failure telemetry', () => {
    it('emits failure telemetry for non-existent memory', async () => {
      const result = await runCLI(['remove', 'memory', '--name', 'DoesNotExist', '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({ command: 'remove.memory', exit_reason: 'failure' });
    });

    it('emits failure telemetry for non-existent credential', async () => {
      const result = await runCLI(['remove', 'credential', '--name', 'DoesNotExist', '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode).toBe(1);
      telemetry.assertMetricEmitted({ command: 'remove.credential', exit_reason: 'failure' });
    });
  });

  describe('remove all', () => {
    it('resets all schemas and emits telemetry', async () => {
      const result = await runCLI(['remove', 'all', '--yes', '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      telemetry.assertMetricEmitted({ command: 'remove.all', exit_reason: 'success' });
    });
  });
});
