import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove identity command', () => {
  let testDir: string;
  let projectDir: string;
  const projectName = 'RemoveIdentityProj';
  const ownerAgent = 'OwnerAgent';
  const userAgent = 'UserAgent';
  const identityName = 'TestIdentity';
  const qualifiedIdentityName = `${projectName}${identityName}`; // Provider names are qualified with project name

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-identity-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add owner agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        ownerAgent,
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
      throw new Error(`Failed to create owner agent: ${result.stdout} ${result.stderr}`);
    }

    // Add user agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        userAgent,
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
      throw new Error(`Failed to create user agent: ${result.stdout} ${result.stderr}`);
    }

    // Add identity
    result = await runCLI(
      [
        'add',
        'identity',
        '--name',
        identityName,
        '--type',
        'ApiKeyCredentialProvider',
        '--api-key',
        'test-key-123',
        '--owner',
        ownerAgent,
        '--json',
      ],
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
    it('removes identity without users', async () => {
      // Add a temp identity to remove
      const tempId = `tempId${Date.now()}`;
      const qualifiedTempId = `${projectName}${tempId}`; // Provider names are qualified with project name
      await runCLI(
        [
          'add',
          'identity',
          '--name',
          tempId,
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'temp-key',
          '--owner',
          ownerAgent,
          '--json',
        ],
        projectDir
      );

      // Remove using qualified name
      const result = await runCLI(['remove', 'identity', '--name', qualifiedTempId, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify identity is removed from owner
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const identity = agent?.identityProviders?.find((i: { name: string }) => i.name === qualifiedTempId);
      expect(!identity, 'Identity should be removed from owner').toBeTruthy();
    });

    it('removes identity with users using cascade policy (default)', async () => {
      // Attach identity to user agent using qualified name
      await runCLI(
        ['attach', 'identity', '--agent', userAgent, '--identity', qualifiedIdentityName, '--json'],
        projectDir
      );

      // Remove with cascade policy (default) - should succeed and clean up references
      const result = await runCLI(['remove', 'identity', '--name', qualifiedIdentityName, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify identity is removed from both owner and user
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const owner = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const user = projectSpec.agents.find((a: { name: string }) => a.name === userAgent);
      expect(owner?.identityProviders?.find((i: { name: string }) => i.name === qualifiedIdentityName)).toBeUndefined();
      expect(user?.identityProviders?.find((i: { name: string }) => i.name === qualifiedIdentityName)).toBeUndefined();
    });
  });
});
