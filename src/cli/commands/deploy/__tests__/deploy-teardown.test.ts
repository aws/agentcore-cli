import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('destroy command removed', () => {
  it('destroy does not appear as a command in help output', async () => {
    const result = await runCLI(['--help'], process.cwd());
    expect(result.exitCode).toBe(0);
    // Verify 'destroy' is not listed as a command
    // Extract the commands section and check no line starts with destroy
    const lines = result.stdout.split('\n').map(l => l.trim());
    const commandLines = lines.filter(l => /^\w/.test(l));
    expect(commandLines.some(l => l.startsWith('destroy'))).toBe(false);
  });
});

describe('deploy with empty agents and deployed state (teardown)', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-deploy-teardown-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project without agents
    const projectName = 'TeardownTestProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('rejects deploy when no agents and no deployed state', async () => {
    // With no agents and empty deployed-state, deploy should fail
    const result = await runCLI(['deploy', '--json'], projectDir);
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
  });

  it('requires --yes to confirm teardown deploy when deployed state exists', async () => {
    // Write aws-targets.json so deploy can find the target
    const awsTargetsPath = join(projectDir, 'agentcore', 'aws-targets.json');

    await writeFile(
      awsTargetsPath,
      JSON.stringify([{ name: 'default', account: '123456789012', region: 'us-east-1' }])
    );

    // Simulate that a previous deploy happened by writing to deployed-state.json
    // deployed-state.json lives in agentcore/.cli/
    const cliDir = join(projectDir, 'agentcore', '.cli');
    await mkdir(cliDir, { recursive: true });
    const deployedStatePath = join(cliDir, 'deployed-state.json');

    await writeFile(
      deployedStatePath,
      JSON.stringify({
        targets: {
          default: {
            resources: {
              stackName: 'TeardownTestProj-default',
              agents: {
                OldAgent: {
                  runtimeId: 'rt-123',
                  runtimeArn: 'arn:aws:agentcore:us-east-1:123456789012:runtime/rt-123',
                  roleArn: 'arn:aws:iam::123456789012:role/test-role',
                },
              },
            },
          },
        },
      })
    );

    // Without --yes, deploy should fail asking for confirmation
    const result = await runCLI(['deploy', '--json'], projectDir);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase()).toContain('teardown');
    expect(json.error).toContain('--yes');
  }, 90000);

  it('allows teardown deploy with --yes flag when deployed state exists', async () => {
    // With --yes, deploy should proceed past the teardown confirmation
    // It will eventually fail on AWS/CDK (no real credentials), but NOT on "no agents" or "teardown"
    const result = await runCLI(['deploy', '--json', '--yes'], projectDir);
    const json = JSON.parse(result.stdout);
    expect(
      !json.error?.toLowerCase().includes('no agents'),
      `Should not fail with "no agents" when deployed state exists. Got: ${json.error}`
    ).toBe(true);
    expect(
      !json.error?.toLowerCase().includes('teardown'),
      `Should not fail with teardown confirmation when --yes is passed. Got: ${json.error}`
    ).toBe(true);
  }, 90000);
});
