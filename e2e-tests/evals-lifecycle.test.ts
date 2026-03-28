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

describe.sequential('e2e: evaluations lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eEval${String(Date.now()).slice(-8)}`;
  const evalName = 'E2eEvaluator';
  const onlineEvalName = 'E2eOnlineEval';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-evals-${randomUUID()}`);
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
    'configures evaluator and online eval before deploy',
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
        'Evaluate the overall quality of this session. Context: {context}',
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
    'deploys agent with evaluator and online eval config',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);
      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }
      expect(result.exitCode, 'Deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
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
    'runs on-demand evaluation against agent traces',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'eval',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `Run eval failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('run');
          expect(json).toHaveProperty('filePath');
        },
        18,
        10000
      );
    },
    300000
  );

  it.skipIf(!canRun)(
    'eval history shows the completed run',
    async () => {
      const result = await run(['evals', 'history', '--runtime', agentName, '--json']);
      expect(result.exitCode, `Evals history failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown> & { runs: unknown[] };
      expect(json).toHaveProperty('success', true);
      expect(json.runs.length, 'Should have at least one eval run').toBeGreaterThan(0);
    },
    120000
  );

  it.skipIf(!canRun)(
    'pauses the online eval config',
    async () => {
      const result = await run(['pause', 'online-eval', onlineEvalName, '--json']);
      expect(result.exitCode, `Pause failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('executionStatus', 'DISABLED');
    },
    120000
  );

  it.skipIf(!canRun)(
    'resumes the online eval config',
    async () => {
      const result = await run(['resume', 'online-eval', onlineEvalName, '--json']);
      expect(result.exitCode, `Resume failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('executionStatus', 'ENABLED');
    },
    120000
  );
});
