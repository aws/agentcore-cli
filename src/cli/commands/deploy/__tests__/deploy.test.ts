import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('deploy --help', () => {
  it('shows verbose option', async () => {
    const result = await runCLI(['deploy', '--help'], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes('--verbose'), 'Should show --verbose option').toBeTruthy();
    expect(result.stdout.includes('resource-level'), 'Should describe resource-level events').toBeTruthy();
  });

  it('shows all deploy options', async () => {
    const result = await runCLI(['deploy', '--help'], process.cwd());
    expect(result.stdout.includes('--target')).toBeTruthy();
    expect(result.stdout.includes('--yes')).toBeTruthy();
    expect(result.stdout.includes('--verbose')).toBeTruthy();
    expect(result.stdout.includes('--json')).toBeTruthy();
    expect(result.stdout.includes('--plan')).toBeTruthy();
  });
});

describe('deploy command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-deploy-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent and target
    const projectName = 'DeployTestProj';
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
    it('validates target exists before deploying', async () => {
      // Deploy with valid target should fail on AWS/CDK, not target validation
      const result = await runCLI(['deploy', '--target', 'test-target', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      // Error should be about AWS/CDK, not about target not found
      expect(!json.error.includes('not found'), `Should find target, got: ${json.error}`).toBeTruthy();
    }, 90000);
  });

  describe('target validation', () => {
    it('rejects non-existent target', async () => {
      const result = await runCLI(['deploy', '--target', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });
});

describe('deploy without agents (Issue #151)', () => {
  let noAgentTestDir: string;
  let noAgentProjectDir: string;

  beforeAll(async () => {
    noAgentTestDir = join(tmpdir(), `agentcore-deploy-noagent-${randomUUID()}`);
    await mkdir(noAgentTestDir, { recursive: true });

    // Create project without any agents
    const projectName = 'NoAgentProject';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], noAgentTestDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    noAgentProjectDir = join(noAgentTestDir, projectName);

    // Add a target but no agent
    const targetResult = await runCLI(
      ['add', 'target', '--name', 'test-target', '--account', '123456789012', '--region', 'us-east-1', '--json'],
      noAgentProjectDir
    );
    if (targetResult.exitCode !== 0) {
      throw new Error(`Failed to create target: ${targetResult.stdout} ${targetResult.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(noAgentTestDir, { recursive: true, force: true });
  });

  it('rejects deploy when no agents are defined', async () => {
    const result = await runCLI(['deploy', '--target', 'test-target', '--json'], noAgentProjectDir);
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase()).toContain('no agents');
  });
});
