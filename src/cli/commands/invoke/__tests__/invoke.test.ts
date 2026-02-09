import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('invoke command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-invoke-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent and target
    const projectName = 'InvokeTestProj';
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

    // Add a target
    result = await runCLI(
      ['add', 'target', '--name', 'test-target', '--account', '123456789012', '--region', 'us-east-1', '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create target: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires prompt for JSON output', async () => {
      const result = await runCLI(['invoke', '--json', '--target', 'test-target'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('Prompt'), `Error should mention Prompt: ${json.error}`).toBeTruthy();
    });

    // Target defaults to 'default' so no validation needed
  });

  describe('agent/target validation', () => {
    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['invoke', 'hello', '--target', 'test-target', '--agent', 'nonexistent', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.includes('not found') || json.error.includes('No deployed'),
        `Error should mention not found: ${json.error}`
      ).toBeTruthy();
    });

    it('requires --agent when multiple agents exist', async () => {
      // Add a second agent
      await runCLI(
        [
          'add',
          'agent',
          '--name',
          'SecondAgent',
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

      // Write a mock deployed state - target name must match aws-targets.json
      const { writeFile, mkdir } = await import('node:fs/promises');
      const cliDir = join(projectDir, 'agentcore', '.cli');
      await mkdir(cliDir, { recursive: true });
      await writeFile(
        join(cliDir, 'deployed-state.json'),
        JSON.stringify({
          targets: {
            'test-target': { resources: { agents: {} } },
          },
        })
      );

      const result = await runCLI(['invoke', 'hello', '--target', 'test-target', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Multiple agents found');
      expect(json.error).toContain('--agent');
    });
  });

  // Merged from invoke-streaming.test.ts
  describe('streaming', () => {
    it('command accepts --stream flag', async () => {
      const result = await runCLI(['invoke', 'hello', '--stream', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('deploy') || json.error.toLowerCase().includes('target'),
        `Error should be about deployment: ${json.error}`
      ).toBeTruthy();
    });

    it('--stream works with --agent flag', async () => {
      const result = await runCLI(['invoke', 'hello', '--stream', '--agent', 'TestAgent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('deploy') || json.error.toLowerCase().includes('target'),
        `Error should be about deployment: ${json.error}`
      ).toBeTruthy();
    });

    it('--stream with invalid agent returns error', async () => {
      const result = await runCLI(['invoke', 'hello', '--stream', '--agent', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.length > 0, 'Should have error message').toBeTruthy();
    });

    it('requires prompt for streaming', async () => {
      const result = await runCLI(['invoke', '--stream', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('prompt') || json.error.toLowerCase().includes('deploy'),
        `Error should mention prompt or deployment: ${json.error}`
      ).toBeTruthy();
    });
  });
});
