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

describe.sequential('e2e: third-party evaluator lifecycle (DeepEval + Autoevals)', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2e3pEval${String(Date.now()).slice(-8)}`;
  const deepevalEvalName = 'answer_relevancy';
  const autoevalsEvalName = 'exact_match';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-3p-eval-${randomUUID()}`);
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
    'adds a DeepEval 3P evaluator with --3p-template-json',
    async () => {
      const templateJson = JSON.stringify({
        library: 'deepeval',
        metric: 'AnswerRelevancyMetric',
        modelProvider: 'bedrock',
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        params: { threshold: 0.5 },
      });
      const result = await run([
        'add',
        'evaluator',
        '--name',
        deepevalEvalName,
        '--level',
        'TRACE',
        '--type',
        'code-based',
        '--3p-template-json',
        templateJson,
        '--json',
      ]);
      expect(result.exitCode, `Add DeepEval evaluator failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; evaluatorName: string; codePath: string };
      expect(json.success).toBe(true);
      expect(json.evaluatorName).toBe(deepevalEvalName);
      expect(json.codePath).toContain(deepevalEvalName);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds an Autoevals 3P evaluator with --3p-template-json',
    async () => {
      const templateJson = JSON.stringify({
        library: 'autoevals',
        metric: 'ExactMatch',
        modelProvider: 'bedrock',
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      });
      const result = await run([
        'add',
        'evaluator',
        '--name',
        autoevalsEvalName,
        '--level',
        'TRACE',
        '--type',
        'code-based',
        '--3p-template-json',
        templateJson,
        '--json',
      ]);
      expect(result.exitCode, `Add Autoevals evaluator failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; evaluatorName: string; codePath: string };
      expect(json.success).toBe(true);
      expect(json.evaluatorName).toBe(autoevalsEvalName);
      expect(json.codePath).toContain(autoevalsEvalName);
    },
    60000
  );

  it.skipIf(!canRun)(
    'deploys agent with 3P evaluators',
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
    'invokes the deployed agent to generate traces',
    async () => {
      await retry(
        async () => {
          const result = await run(['invoke', '--prompt', 'What is 2+2?', '--runtime', agentName, '--json']);
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
    'runs on-demand evaluation with DeepEval 3P evaluator',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'eval',
            '--runtime',
            agentName,
            '--evaluator',
            deepevalEvalName,
            '--days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `Run eval failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('run');
        },
        18,
        10000
      );
    },
    300000
  );

  it.skipIf(!canRun)(
    'runs on-demand evaluation with Autoevals 3P evaluator',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'eval',
            '--runtime',
            agentName,
            '--evaluator',
            autoevalsEvalName,
            '--days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `Run eval failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('run');
        },
        18,
        10000
      );
    },
    300000
  );
});
