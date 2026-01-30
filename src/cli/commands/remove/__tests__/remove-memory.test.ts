import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove memory command', () => {
  let testDir: string;
  let projectDir: string;
  const ownerAgent = 'OwnerAgent';
  const userAgent = 'UserAgent';
  const memoryName = 'TestMemory';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-memory-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveMemoryProj';
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

    // Add memory
    result = await runCLI(
      ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC', '--owner', ownerAgent, '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create memory: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'memory', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent memory', async () => {
      const result = await runCLI(['remove', 'memory', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove operations', () => {
    it('removes memory without users', async () => {
      // Add a temp memory to remove
      const tempMem = `tempMem${Date.now()}`;
      const addResult = await runCLI(
        ['add', 'memory', '--name', tempMem, '--strategies', 'SEMANTIC', '--owner', ownerAgent, '--json'],
        projectDir
      );
      expect(addResult.exitCode, `Add failed: ${addResult.stdout} ${addResult.stderr}`).toBe(0);

      const result = await runCLI(['remove', 'memory', '--name', tempMem, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify memory is removed from owner
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === tempMem);
      expect(!memory, 'Memory should be removed from owner').toBeTruthy();
    });

    it('removes memory with users using cascade policy (default)', async () => {
      // Attach memory to user agent
      await runCLI(['attach', 'memory', '--agent', userAgent, '--memory', memoryName, '--json'], projectDir);

      // Remove with cascade policy (default) - should succeed and clean up references
      const result = await runCLI(['remove', 'memory', '--name', memoryName, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify memory is removed from both owner and user
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const owner = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const user = projectSpec.agents.find((a: { name: string }) => a.name === userAgent);
      expect(owner?.memoryProviders?.find((m: { name: string }) => m.name === memoryName)).toBeUndefined();
      expect(user?.memoryProviders?.find((m: { name: string }) => m.name === memoryName)).toBeUndefined();
    });
  });
});
