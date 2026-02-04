import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add identity command', () => {
  let testDir: string;
  let projectDir: string;
  const projectName = 'IdentityProj';
  const ownerAgent = 'OwnerAgent';
  const userAgent = 'UserAgent';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-identity-${randomUUID()}`);
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

    it('requires type flag', async () => {
      const result = await runCLI(['add', 'identity', '--name', 'test', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--type'), `Error: ${json.error}`).toBeTruthy();
    });

    it('validates type value', async () => {
      const result = await runCLI(
        ['add', 'identity', '--name', 'test', '--type', 'Invalid', '--api-key', 'xxx', '--owner', ownerAgent, '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('ApiKeyCredentialProvider'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires api-key flag', async () => {
      const result = await runCLI(
        ['add', 'identity', '--name', 'test', '--type', 'ApiKeyCredentialProvider', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--api-key'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires owner flag', async () => {
      const result = await runCLI(
        ['add', 'identity', '--name', 'test', '--type', 'ApiKeyCredentialProvider', '--api-key', 'xxx', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--owner'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('identity creation', () => {
    it('creates identity with owner', async () => {
      const identityName = `id${Date.now()}`;
      const qualifiedName = `${projectName}${identityName}`; // Provider names are qualified with project name
      const result = await runCLI(
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

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.identityName).toBe(qualifiedName);
      expect(json.ownerAgent).toBe(ownerAgent);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const identity = agent?.identityProviders?.find((i: { name: string }) => i.name === qualifiedName);
      expect(identity, 'Identity should be on owner agent').toBeTruthy();
      expect(identity.relation).toBe('own');
    });

    it('creates identity with owner and users', async () => {
      const identityName = `shared${Date.now()}`;
      const qualifiedName = `${projectName}${identityName}`; // Provider names are qualified with project name
      const result = await runCLI(
        [
          'add',
          'identity',
          '--name',
          identityName,
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'shared-key-456',
          '--owner',
          ownerAgent,
          '--users',
          userAgent,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.userAgents).toEqual([userAgent]);

      // Verify relations
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));

      const owner = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const ownerIdentity = owner?.identityProviders?.find((i: { name: string }) => i.name === qualifiedName);
      expect(ownerIdentity?.relation).toBe('own');

      const user = projectSpec.agents.find((a: { name: string }) => a.name === userAgent);
      const userIdentity = user?.identityProviders?.find((i: { name: string }) => i.name === qualifiedName);
      expect(userIdentity?.relation).toBe('use');
    });
  });
});
