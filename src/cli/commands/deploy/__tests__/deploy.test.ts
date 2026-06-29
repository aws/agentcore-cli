import { runCLI } from '../../../../test-utils/index.js';
import { runDeploy, runDiff, selectTargetStack } from '../actions.js';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('deploy --help', () => {
  it('shows all deploy options', async () => {
    const result = await runCLI(['deploy', '--help'], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes('--yes')).toBeTruthy();
    expect(result.stdout.includes('--verbose')).toBeTruthy();
    expect(result.stdout.includes('--json')).toBeTruthy();
    expect(result.stdout.includes('--dry-run')).toBeTruthy();
    expect(result.stdout.includes('resource-level'), 'Should describe resource-level events').toBeTruthy();
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

  it('rejects deploy when no resources are defined', async () => {
    const result = await runCLI(['deploy', '--json'], noAgentProjectDir);
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toBeDefined();
    expect(json.error.toLowerCase()).toContain('no resources defined');
  });
});

describe('selectTargetStack', () => {
  // Multi-target projects synth one stack per target in aws-targets.json. The deploy flow
  // must persist/describe the stack for the *deployed* target — not blindly stackNames[0].
  // Regression guard for: `deploy --target qa` failing at Persist because the CLI described
  // the first target's stack (e.g. AgentCore-myapp-default) instead of the qa stack.
  it('selects the deployed target stack, not the first synthesized stack', () => {
    const result = selectTargetStack(['AgentCore-myapp-default', 'AgentCore-myapp-qa'], 'myapp', 'qa');
    expect(result).toEqual({ success: true, stackName: 'AgentCore-myapp-qa' });
  });

  it('selects the target stack regardless of ordering in the assembly', () => {
    const result = selectTargetStack(['AgentCore-myapp-qa', 'AgentCore-myapp-default'], 'myapp', 'default');
    expect(result).toEqual({ success: true, stackName: 'AgentCore-myapp-default' });
  });

  it('handles single-target projects', () => {
    const result = selectTargetStack(['AgentCore-myapp-default'], 'myapp', 'default');
    expect(result).toEqual({ success: true, stackName: 'AgentCore-myapp-default' });
  });

  it('normalizes underscores in project and target names to match synthesized names', () => {
    const result = selectTargetStack(['AgentCore-my-app-qa-east'], 'my_app', 'qa_east');
    expect(result).toEqual({ success: true, stackName: 'AgentCore-my-app-qa-east' });
  });

  it('fails when no stacks were synthesized', () => {
    const result = selectTargetStack([], 'myapp', 'qa');
    expect(result.success).toBe(false);
  });

  it('fails when the deployed target has no matching synthesized stack', () => {
    const result = selectTargetStack(['AgentCore-myapp-default'], 'myapp', 'qa');
    expect(result.success).toBe(false);
  });
});

describe('runDiff', () => {
  it('passes stack selection pattern to toolkit wrapper diff', async () => {
    let captured: unknown;
    const fakeWrapper = {
      diff: (opts?: unknown) => {
        captured = opts;
      },
    };

    await runDiff(fakeWrapper as any, 'AgentCore-myapp-prod');

    expect(captured).toEqual({
      stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['AgentCore-myapp-prod'] },
    });
  });
});

describe('runDeploy', () => {
  it('passes stack selection pattern to toolkit wrapper deploy', async () => {
    let captured: unknown;
    const fakeWrapper = {
      deploy: (opts?: unknown) => {
        captured = opts;
      },
    };

    await runDeploy(fakeWrapper as any, 'AgentCore-myapp-prod');

    expect(captured).toEqual({
      stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['AgentCore-myapp-prod'] },
    });
  });
});
