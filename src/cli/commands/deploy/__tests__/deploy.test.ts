import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
    expect(result.stdout.includes('--yes')).toBeTruthy();
    expect(result.stdout.includes('--verbose')).toBeTruthy();
    expect(result.stdout.includes('--json')).toBeTruthy();
    expect(result.stdout.includes('--plan')).toBeTruthy();
  });
});

describe('deploy without agents', () => {
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

    // Write aws-targets.json directly (replaces old 'add target' command)
    const awsTargetsPath = join(noAgentProjectDir, 'agentcore', 'aws-targets.json');

    await writeFile(
      awsTargetsPath,
      JSON.stringify([{ name: 'default', account: '123456789012', region: 'us-east-1' }])
    );
  });

  afterAll(async () => {
    await rm(noAgentTestDir, { recursive: true, force: true });
  });

  it('rejects deploy when no agents are defined', async () => {
    const result = await runCLI(['deploy', '--json'], noAgentProjectDir);
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
    expect(json.error.toLowerCase()).toContain('no agents');
  });
});
