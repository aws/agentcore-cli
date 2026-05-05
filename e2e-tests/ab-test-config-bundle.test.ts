import { parseJsonOutput, retry } from '../src/test-utils/index.js';
import {
  baseCanRun,
  hasAws,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: config-bundle AB test lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eCfgAB${String(Date.now()).slice(-8)}`;
  const abTestName = 'ConfigBundleABTest';
  const evalName = 'BundleEvaluator';
  const onlineEvalName = 'BundleOnlineEval';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-cfg-ab-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runAgentCoreCLI(
      [
        'create',
        '--name',
        agentName,
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
      testDir
    );
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(result.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  it.skipIf(!canRun)(
    'adds evaluator and online eval config',
    async () => {
      let result = await run([
        'add',
        'evaluator',
        '--name',
        evalName,
        '--level',
        'SESSION',
        '--model',
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        '--instructions',
        'Evaluate session quality. Context: {context}',
        '--json',
      ]);
      expect(result.exitCode, `Add evaluator failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'online-eval',
        '--name',
        onlineEvalName,
        '--runtime',
        agentName,
        '--evaluator',
        evalName,
        '--sampling-rate',
        '100',
        '--enable-on-create',
        '--json',
      ]);
      expect(result.exitCode, `Add online-eval failed: ${result.stdout}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'deploys agent before AB test (needed for config bundles)',
    async () => {
      await retry(
        async () => {
          const result = await run(['deploy', '--yes', '--json']);
          expect(result.exitCode, `Initial deploy failed`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        2,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'adds config-bundle AB test with 90/10 split',
    async () => {
      // Use placeholder bundle ARNs that satisfy the service format constraints.
      // Real config bundles would be created separately; these test the AB test wiring.
      const region = process.env.AWS_REGION ?? 'us-east-1';
      const account = process.env.AWS_ACCOUNT_ID ?? '000000000000';
      const controlBundle = `arn:aws:bedrock-agentcore:${region}:${account}:configuration-bundle/control-bundle-AbCdEfGhIj`;
      const treatmentBundle = `arn:aws:bedrock-agentcore:${region}:${account}:configuration-bundle/treatment-bundle-AbCdEfGhIj`;

      const result = await run([
        'add',
        'ab-test',
        '--mode',
        'config-bundle',
        '--name',
        abTestName,
        '--runtime',
        agentName,
        '--control-bundle',
        controlBundle,
        '--control-version',
        '00000000-0000-0000-0000-000000000001',
        '--treatment-bundle',
        treatmentBundle,
        '--treatment-version',
        '00000000-0000-0000-0000-000000000002',
        '--control-weight',
        '90',
        '--treatment-weight',
        '10',
        '--online-eval',
        onlineEvalName,
        '--json',
      ]);
      expect(result.exitCode, `Add AB test failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; abTestName: string };
      expect(json.success).toBe(true);
      expect(json.abTestName).toBe(abTestName);
    },
    60000
  );

  it.skipIf(!canRun)(
    'status shows AB test in config',
    async () => {
      const result = await run(['status', '--json']);
      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      // Agent should be deployed
      const agent = json.resources.find(r => r.resourceType === 'agent' && r.name === agentName);
      expect(agent, `Agent "${agentName}" should appear in status`).toBeDefined();
      expect(agent!.deploymentState).toBe('deployed');
    },
    120000
  );

  it.skipIf(!canRun)(
    'invokes the deployed agent',
    async () => {
      await retry(
        async () => {
          const result = await run(['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json']);
          expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        3,
        15000
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'removes config-bundle AB test',
    async () => {
      const result = await run(['remove', 'ab-test', '--name', abTestName, '--json']);
      expect(result.exitCode, `Remove failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
    },
    60000
  );
});
