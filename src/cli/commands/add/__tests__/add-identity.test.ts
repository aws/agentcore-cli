import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add identity command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-identity-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'IdentityProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['add', 'identity', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires api-key flag', async () => {
      const result = await runCLI(['add', 'identity', '--name', 'test', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--api-key'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('identity creation', () => {
    it('creates credential as top-level resource', async () => {
      const identityName = `id${Date.now()}`;
      const result = await runCLI(
        ['add', 'identity', '--name', identityName, '--api-key', 'test-key-123', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.credentialName).toBe(identityName);

      // Verify in agentcore.json as top-level credential
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const credential = projectSpec.credentials.find((c: { name: string }) => c.name === identityName);
      expect(credential, 'Credential should be in project credentials').toBeTruthy();
      expect(credential.type).toBe('ApiKeyCredentialProvider');
    });
  });
});
