import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it , expect } from 'vitest';

describe('removal policy restrict', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-removal-policy-restrict-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('memory restrict', () => {
    it('blocks removal when memory has users (default restrict)', async () => {
      // Create fresh project
      const projectName = `MemRestrictProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add owner and user agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Owner',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'User',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Add memory with user
      result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          'SharedMem',
          '--strategies',
          'SEMANTIC',
          '--owner',
          'Owner',
          '--users',
          'User',
          '--json',
        ],
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Try to remove memory without cascade - should fail
      result = await runCLI(['remove', 'memory', '--name', 'SharedMem', '--json'], projDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('use') || json.error.toLowerCase().includes('attached'),
        `Error: ${json.error}`
      ).toBeTruthy();
    });

    it('blocks removal with explicit restrict policy', async () => {
      // Create fresh project
      const projectName = `MemRestrictExplicitProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add owner and user agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Owner',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'User',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Add memory with user
      result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          'SharedMem',
          '--strategies',
          'SEMANTIC',
          '--owner',
          'Owner',
          '--users',
          'User',
          '--json',
        ],
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Try to remove with explicit restrict - should fail
      result = await runCLI(['remove', 'memory', '--name', 'SharedMem', '--policy', 'restrict', '--json'], projDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });
  });

  describe('identity restrict', () => {
    it('blocks removal when identity has users', async () => {
      // Create fresh project
      const projectName = `IdRestrictProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add owner and user agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Owner',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'User',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Add identity with user
      result = await runCLI(
        [
          'add',
          'identity',
          '--name',
          'SharedId',
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'test-key',
          '--owner',
          'Owner',
          '--users',
          'User',
          '--json',
        ],
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Try to remove identity - should fail
      result = await runCLI(['remove', 'identity', '--name', 'SharedId', '--json'], projDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('use') || json.error.toLowerCase().includes('attached'),
        `Error: ${json.error}`
      ).toBeTruthy();
    });
  });

  describe('agent restrict', () => {
    it('blocks removal when agent is referenced by others', async () => {
      // Create fresh project
      const projectName = `AgentRestrictProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add two agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'AgentA',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'AgentB',
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
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Attach AgentB to AgentA
      result = await runCLI(['attach', 'agent', '--source', 'AgentA', '--target', 'AgentB', '--json'], projDir);
      expect(result.exitCode).toBe(0);

      // Try to remove AgentB - should fail with restrict
      result = await runCLI(['remove', 'agent', '--name', 'AgentB', '--json'], projDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('reference') || json.error.toLowerCase().includes('use'),
        `Error: ${json.error}`
      ).toBeTruthy();
    });
  });
});
