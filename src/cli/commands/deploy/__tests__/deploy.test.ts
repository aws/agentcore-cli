import { runCLI } from '../../../../test-utils/index.js';
import { runDeploy, runDiff, selectTargetStack } from '../actions.js';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// Regression for the preview-mode vpcId backfill: `deploy --dry-run` on a pre-existing Container+VPC
// config missing vpcId resolves + writes it to disk for synth, but must revert on EVERY exit path —
// including when synth/bootstrap fails (no real creds here) — so a preview never dirties the tree.
describe('deploy --dry-run preview does not dirty a vpcId-less Container+VPC config', () => {
  let testDir: string;
  let projectDir: string;
  let agentConfigPath: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-deploy-preview-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const projectName = 'PreviewVpcProj';
    const dockerfile = join(testDir, 'Dockerfile');
    await writeFile(dockerfile, 'FROM public.ecr.aws/lambda/python:3.12\n');

    // Container + VPC agent, created WITH a vpcId...
    const create = await runCLI(
      [
        'create',
        '--project-name',
        projectName,
        '--name',
        'pvagent',
        '--build',
        'Container',
        '--network-mode',
        'VPC',
        '--subnets',
        'subnet-0123456789abcdef0',
        '--security-groups',
        'sg-0123456789abcdef0',
        '--vpc-id',
        'vpc-0123456789abcdef0',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
      ],
      testDir
    );
    if (create.exitCode !== 0) {
      throw new Error(`Failed to create project: ${create.stdout} ${create.stderr}`);
    }
    projectDir = join(testDir, projectName);
    agentConfigPath = join(projectDir, 'agentcore', 'agentcore.json');

    await writeFile(
      join(projectDir, 'agentcore', 'aws-targets.json'),
      JSON.stringify([{ name: 'default', account: '123456789012', region: 'us-east-1' }])
    );

    // ...then strip the vpcId to simulate a config written before the field existed.
    const spec = JSON.parse(await readFile(agentConfigPath, 'utf-8'));
    for (const rt of spec.runtimes ?? []) {
      if (rt.networkConfig) delete rt.networkConfig.vpcId;
    }
    await writeFile(agentConfigPath, JSON.stringify(spec, null, 2));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('leaves agentcore.json unchanged after a --dry-run (even when the preview fails without creds)', async () => {
    const before = await readFile(agentConfigPath, 'utf-8');
    expect(before).not.toContain('vpcId');

    // No real AWS creds/bootstrap in CI, so the dry-run will fail somewhere after the backfill (at
    // DescribeSubnets or synth). Either way the finally-block restore must revert the file.
    await runCLI(['deploy', '--dry-run', '--json'], projectDir);

    const after = await readFile(agentConfigPath, 'utf-8');
    expect(after, 'preview must not persist the backfilled vpcId').toBe(before);
    expect(after).not.toContain('vpcId');
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
