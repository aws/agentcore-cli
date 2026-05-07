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

describe.sequential('e2e: target-based AB test lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eTargAB${String(Date.now()).slice(-8)}`;
  const abTestName = 'TargetABTest';
  const evalName = 'ABTestEvaluator';
  const controlEvalName = 'ControlEvalConfig';
  const treatmentEvalName = 'TreatmentEvalConfig';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-target-ab-${randomUUID()}`);
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
    'adds runtime endpoints (prod v1, staging v1)',
    async () => {
      let result = await run([
        'add',
        'runtime-endpoint',
        '--runtime',
        agentName,
        '--endpoint',
        'prod',
        '--version',
        '1',
        '--json',
      ]);
      expect(result.exitCode, `Add prod endpoint failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'runtime-endpoint',
        '--runtime',
        agentName,
        '--endpoint',
        'staging',
        '--version',
        '1',
        '--json',
      ]);
      expect(result.exitCode, `Add staging endpoint failed: ${result.stdout}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds evaluator and per-variant online eval configs',
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
        'Evaluate quality. Context: {context}',
        '--json',
      ]);
      expect(result.exitCode, `Add evaluator failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'online-eval',
        '--name',
        controlEvalName,
        '--runtime',
        agentName,
        '--evaluator',
        evalName,
        '--sampling-rate',
        '100',
        '--endpoint',
        'prod',
        '--enable-on-create',
        '--json',
      ]);
      expect(result.exitCode, `Add control online-eval failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'online-eval',
        '--name',
        treatmentEvalName,
        '--runtime',
        agentName,
        '--evaluator',
        evalName,
        '--sampling-rate',
        '100',
        '--endpoint',
        'staging',
        '--enable-on-create',
        '--json',
      ]);
      expect(result.exitCode, `Add treatment online-eval failed: ${result.stdout}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds target-based AB test with 90/10 split',
    async () => {
      const result = await run([
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        abTestName,
        '--runtime',
        agentName,
        '--gateway',
        `${abTestName}-gw`,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '90',
        '--treatment-weight',
        '10',
        '--control-online-eval',
        controlEvalName,
        '--treatment-online-eval',
        treatmentEvalName,
        '--enable',
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
    'deploys project (creates gateway, targets, AB test, eval configs)',
    async () => {
      await retry(
        async () => {
          const result = await run(['deploy', '--yes', '--json']);
          expect(result.exitCode, `Deploy failed (stderr: ${result.stderr})`).toBe(0);
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
    'AB test reaches RUNNING status after deploy',
    async () => {
      await retry(
        async () => {
          const result = await run(['ab-test', abTestName, '--json']);
          expect(result.exitCode, `ab-test lookup failed: ${result.stdout} ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { executionStatus: string };
          expect(json.executionStatus, 'AB test should be RUNNING after deploy').toBe('RUNNING');
        },
        12,
        15000
      );
    },
    300000
  );

  it.skipIf(!canRun)(
    'status shows all resources deployed',
    async () => {
      await retry(
        async () => {
          const result = await run(['status', '--json']);
          expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

          const json = parseJsonOutput(result.stdout) as {
            success: boolean;
            resources: { resourceType: string; name: string; deploymentState: string; invocationUrl?: string }[];
          };
          expect(json.success).toBe(true);

          // Agent should be deployed
          const agent = json.resources.find(r => r.resourceType === 'agent' && r.name === agentName);
          expect(agent, `Agent "${agentName}" should appear in status`).toBeDefined();
          expect(agent!.deploymentState).toBe('deployed');

          // AB test should be deployed (HTTP gateways are not surfaced as top-level status resources)
          const abTest = json.resources.find(r => r.resourceType === 'ab-test' && r.name === abTestName);
          expect(abTest, `AB test "${abTestName}" should appear in status`).toBeDefined();
          expect(abTest!.deploymentState).toBe('deployed');
          // invocationUrl proves the HTTP gateway was deployed and wired up correctly
          expect(abTest!.invocationUrl, 'AB test should have a gateway invocation URL').toBeTruthy();
        },
        3,
        15000
      );
    },
    120000
  );

  it.skipIf(!canRun)(
    'pauses AB test',
    async () => {
      await retry(
        async () => {
          const result = await run(['pause', 'ab-test', abTestName, '--json']);
          expect(result.exitCode, `Pause failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('executionStatus', 'PAUSED');
        },
        3,
        10000
      );
    },
    120000
  );

  it.skipIf(!canRun)(
    'resumes AB test',
    async () => {
      await retry(
        async () => {
          const result = await run(['resume', 'ab-test', abTestName, '--json']);
          expect(result.exitCode, `Resume failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('executionStatus', 'RUNNING');
        },
        3,
        10000
      );
    },
    120000
  );

  it.skipIf(!canRun)(
    'promotes AB test (updates agentcore.json)',
    async () => {
      const result = await run(['promote', 'ab-test', abTestName, '--json']);
      expect(result.exitCode, `Promote failed: ${result.stdout} ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('promoted', true);
    },
    120000
  );

  it.skipIf(!canRun)(
    'removes AB test from config',
    async () => {
      const result = await run(['remove', 'ab-test', '--name', abTestName, '--delete-gateway', '--json']);
      expect(result.exitCode, `Remove failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
    },
    60000
  );
});
