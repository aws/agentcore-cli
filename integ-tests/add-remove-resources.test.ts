import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  });

  describe('memory lifecycle', () => {
    const memoryName = `IntegMem${Date.now().toString().slice(-6)}`;

    it('adds a memory resource', async () => {
      const result = await runCLI(['add', 'memory', '--name', memoryName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const memories = config.memories as Record<string, unknown>[] | undefined;
      expect(memories, 'memories should exist').toBeDefined();
      const found = memories!.some((m: Record<string, unknown>) => m.name === memoryName);
      expect(found, `Memory "${memoryName}" should be in config`).toBe(true);
    });

    it('removes the memory resource', async () => {
      const result = await runCLI(['remove', 'memory', '--name', memoryName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const memories = (config.memories as Record<string, unknown>[] | undefined) ?? [];
      const found = memories.some((m: Record<string, unknown>) => m.name === memoryName);
      expect(found, `Memory "${memoryName}" should be removed from config`).toBe(false);
    });
  });

  describe('identity lifecycle', () => {
    const identityName = `IntegId${Date.now().toString().slice(-6)}`;

    it('adds an identity resource', async () => {
      const result = await runCLI(
        ['add', 'identity', '--name', identityName, '--api-key', 'test-key-integ-123', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const credentials = config.credentials as Record<string, unknown>[] | undefined;
      expect(credentials, 'credentials should exist').toBeDefined();
      const found = credentials!.some((c: Record<string, unknown>) => c.name === identityName);
      expect(found, `Identity "${identityName}" should be in config`).toBe(true);
    });

    it('removes the identity resource', async () => {
      const result = await runCLI(['remove', 'identity', '--name', identityName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const credentials = (config.credentials as Record<string, unknown>[] | undefined) ?? [];
      const found = credentials.some((c: Record<string, unknown>) => c.name === identityName);
      expect(found, `Identity "${identityName}" should be removed from config`).toBe(false);
    });
  });
});
