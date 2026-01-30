import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it , expect } from 'vitest';

describe('agent removal cascade', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-agent-removal-cascade-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('cascade removes owned resources', () => {
    it('removes agent and its owned memory', async () => {
      // Create fresh project for this test
      const projectName = `CascadeMemProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add agent
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'OwnerAgent',
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

      // Add memory owned by agent
      result = await runCLI(
        ['add', 'memory', '--name', 'OwnedMemory', '--strategies', 'SEMANTIC', '--owner', 'OwnerAgent', '--json'],
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Remove agent with cascade
      result = await runCLI(['remove', 'agent', '--name', 'OwnerAgent', '--policy', 'cascade', '--json'], projDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify agent is removed
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      expect(projectSpec.agents.length, 'Agent should be removed').toBe(0);
    });

    it('removes agent and its owned identity', async () => {
      // Create fresh project
      const projectName = `CascadeIdProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      expect(result.exitCode).toBe(0);
      const projDir = join(testDir, projectName);

      // Add agent
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'OwnerAgent',
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

      // Add identity owned by agent
      result = await runCLI(
        [
          'add',
          'identity',
          '--name',
          'OwnedIdentity',
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'test-key',
          '--owner',
          'OwnerAgent',
          '--json',
        ],
        projDir
      );
      expect(result.exitCode).toBe(0);

      // Remove agent with cascade
      result = await runCLI(['remove', 'agent', '--name', 'OwnerAgent', '--policy', 'cascade', '--json'], projDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify agent is removed
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      expect(projectSpec.agents.length, 'Agent should be removed').toBe(0);
    });

    it('removes agent and cleans up remote tool references', async () => {
      // Create fresh project
      const projectName = `CascadeToolProj${Date.now()}`;
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

      // Attach AgentB to AgentA (AgentA can invoke AgentB)
      result = await runCLI(['attach', 'agent', '--source', 'AgentA', '--target', 'AgentB', '--json'], projDir);
      expect(result.exitCode).toBe(0);

      // Remove AgentB with cascade
      result = await runCLI(['remove', 'agent', '--name', 'AgentB', '--policy', 'cascade', '--json'], projDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);

      // Verify AgentA's remote tool reference is cleaned up
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agentA = projectSpec.agents.find((a: { name: string }) => a.name === 'AgentA');
      const hasRef = agentA?.remoteTools?.some((rt: { targetAgentName?: string }) => rt.targetAgentName === 'AgentB');
      expect(!hasRef, 'AgentA should not have reference to removed AgentB').toBeTruthy();
    });
  });
});
