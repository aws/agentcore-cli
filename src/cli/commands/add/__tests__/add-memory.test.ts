import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add memory command', () => {
  let testDir: string;
  let projectDir: string;
  const ownerAgent = 'OwnerAgent';
  const userAgent = 'UserAgent';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-memory-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'MemoryProj';
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
      const result = await runCLI(['add', 'memory', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires strategies flag', async () => {
      const result = await runCLI(['add', 'memory', '--name', 'test', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--strategies'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires owner flag', async () => {
      const result = await runCLI(
        ['add', 'memory', '--name', 'test', '--strategies', 'SEMANTIC', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--owner'), `Error: ${json.error}`).toBeTruthy();
    });

    it('validates strategy types', async () => {
      const result = await runCLI(
        ['add', 'memory', '--name', 'test', '--strategies', 'INVALID', '--owner', ownerAgent, '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('INVALID'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('memory creation', () => {
    it('creates memory with owner', async () => {
      const memoryName = `mem${Date.now()}`;
      const result = await runCLI(
        ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC', '--owner', ownerAgent, '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.memoryName).toBe(memoryName);
      expect(json.ownerAgent).toBe(ownerAgent);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === memoryName);
      expect(memory, 'Memory should be on owner agent').toBeTruthy();
      expect(memory.relation).toBe('own');
    });

    it('creates memory with owner and users', async () => {
      const memoryName = `shared${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          memoryName,
          '--strategies',
          'SUMMARIZATION',
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
      const ownerMem = owner?.memoryProviders?.find((m: { name: string }) => m.name === memoryName);
      expect(ownerMem?.relation).toBe('own');

      const user = projectSpec.agents.find((a: { name: string }) => a.name === userAgent);
      const userMem = user?.memoryProviders?.find((m: { name: string }) => m.name === memoryName);
      expect(userMem?.relation).toBe('use');
    });

    it('creates memory with multiple strategies', async () => {
      const memoryName = `multi${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          memoryName,
          '--strategies',
          'SEMANTIC,SUMMARIZATION',
          '--owner',
          ownerAgent,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify strategies
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === memoryName);
      const strategies = memory?.config?.memoryStrategies?.map((s: { type: string }) => s.type);
      expect(strategies?.includes('SEMANTIC'), 'Should have SEMANTIC').toBeTruthy();
      expect(strategies?.includes('SUMMARIZATION'), 'Should have SUMMARIZATION').toBeTruthy();
    });

    it('creates memory with custom expiry', async () => {
      const memoryName = `expiry${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          memoryName,
          '--strategies',
          'SEMANTIC',
          '--owner',
          ownerAgent,
          '--expiry',
          '90',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify expiry
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === memoryName);
      expect(memory?.config?.eventExpiryDuration).toBe(90);
    });
  });
});
