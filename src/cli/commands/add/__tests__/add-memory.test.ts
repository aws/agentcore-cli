import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add memory command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-memory-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'MemoryProj';
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
      const result = await runCLI(['add', 'memory', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('allows omitting strategies flag', async () => {
      const memoryName = `noStrat${Date.now()}`;
      const result = await runCLI(['add', 'memory', '--name', memoryName, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('validates strategy types', async () => {
      const result = await runCLI(['add', 'memory', '--name', 'test', '--strategies', 'INVALID', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('INVALID'), `Error: ${json.error}`).toBeTruthy();
    });

    // Issue #235: CUSTOM strategy has been removed
    it('rejects CUSTOM strategy', async () => {
      const result = await runCLI(
        ['add', 'memory', '--name', 'testCustom', '--strategies', 'CUSTOM', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('CUSTOM'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('memory creation', () => {
    it('creates memory as top-level resource', async () => {
      const memoryName = `mem${Date.now()}`;
      const result = await runCLI(
        ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.memoryName).toBe(memoryName);

      // Verify in agentcore.json as top-level resource
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const memory = projectSpec.memories.find((m: { name: string }) => m.name === memoryName);
      expect(memory, 'Memory should be in project memories').toBeTruthy();
      expect(memory.type).toBe('AgentCoreMemory');
    });

    it('creates memory with multiple strategies', async () => {
      const memoryName = `multi${Date.now()}`;
      const result = await runCLI(
        ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC,SUMMARIZATION', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify strategies
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const memory = projectSpec.memories.find((m: { name: string }) => m.name === memoryName);
      const strategies = memory?.strategies?.map((s: { type: string }) => s.type);
      expect(strategies?.includes('SEMANTIC'), 'Should have SEMANTIC').toBeTruthy();
      expect(strategies?.includes('SUMMARIZATION'), 'Should have SUMMARIZATION').toBeTruthy();
    });

    it('creates memory with custom expiry', async () => {
      const memoryName = `expiry${Date.now()}`;
      const result = await runCLI(
        ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC', '--expiry', '90', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify expiry
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const memory = projectSpec.memories.find((m: { name: string }) => m.name === memoryName);
      expect(memory?.eventExpiryDuration).toBe(90);
    });

    it('sets default namespaces for each strategy type', async () => {
      const memoryName = `ns${Date.now()}`;
      const result = await runCLI(
        ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC,USER_PREFERENCE,SUMMARIZATION', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify namespaces are set for each strategy
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const memory = projectSpec.memories.find((m: { name: string }) => m.name === memoryName);

      const semantic = memory?.strategies?.find((s: { type: string }) => s.type === 'SEMANTIC');
      expect(semantic?.namespaces).toEqual(['/users/{actorId}/facts']);

      const userPref = memory?.strategies?.find((s: { type: string }) => s.type === 'USER_PREFERENCE');
      expect(userPref?.namespaces).toEqual(['/users/{actorId}/preferences']);

      const summarization = memory?.strategies?.find((s: { type: string }) => s.type === 'SUMMARIZATION');
      expect(summarization?.namespaces).toEqual(['/summaries/{actorId}/{sessionId}']);
    });
  });
});
