import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveTestProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add an agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'TestAgent',
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
      throw new Error(`Failed to create agent: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name for JSON output', async () => {
      const result = await runCLI(['remove', 'agent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error should mention --name: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove agent', () => {
    it('rejects non-existent agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });

    it('removes existing agent with --name and --force (non-interactive)', async () => {
      // Add another agent for this test
      const addResult = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'TUITestAgent',
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
      expect(addResult.exitCode).toBe(0);

      // Remove agent using non-interactive mode with --name and --force (no --json)
      const result = await runCLI(['remove', 'agent', '--name', 'TUITestAgent', '--force'], projectDir);
      expect(result.exitCode).toBe(0);

      // Verify agent is removed from schema
      const schema = JSON.parse(await readFile(join(projectDir, 'agentcore', 'agentcore.json'), 'utf-8'));
      const agent = schema.agents.find((a: { name: string }) => a.name === 'TUITestAgent');
      expect(agent, 'TUITestAgent should be removed from schema').toBeUndefined();
    });

    it('removes existing agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'TestAgent', '--json'], projectDir);
      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify agent is removed from schema
      const schema = JSON.parse(await readFile(join(projectDir, 'agentcore', 'agentcore.json'), 'utf-8'));
      expect(schema.agents.length, 'Agent should be removed from schema').toBe(0);
    });
  });
});
