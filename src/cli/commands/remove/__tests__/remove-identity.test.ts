import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove identity command', () => {
  let testDir: string;
  let projectDir: string;
  const identityName = 'TestIdentity';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-identity-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveIdentityProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add identity as top-level credential
    result = await runCLI(
      ['add', 'identity', '--name', identityName, '--api-key', 'test-key-123', '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create identity: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'identity', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent identity', async () => {
      const result = await runCLI(['remove', 'identity', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove operations', () => {
    it('removes credential without dependents', async () => {
      // Add a temp credential to remove
      const tempId = `tempId${Date.now()}`;
      await runCLI(['add', 'identity', '--name', tempId, '--api-key', 'temp-key', '--json'], projectDir);

      const result = await runCLI(['remove', 'identity', '--name', tempId, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify credential is removed from project
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const credential = projectSpec.credentials.find((c: { name: string }) => c.name === tempId);
      expect(!credential, 'Credential should be removed from project').toBeTruthy();
    });

    it('removes the setup credential', async () => {
      const result = await runCLI(['remove', 'identity', '--name', identityName, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify credential is removed
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      expect(projectSpec.credentials.find((c: { name: string }) => c.name === identityName)).toBeUndefined();
    });
  });
});
