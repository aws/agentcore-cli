/**
 * E2E tests for dataset-driven evaluation integration.
 *
 * Flow: create project WITH agent (Strands, Bedrock, no memory)
 *       → add dataset (predefined, 3 simple scenarios)
 *       → deploy → wait for agent readiness (invoke with retry)
 *       → run eval with --dataset flag using Builtin evaluator → verify results
 *
 * Prerequisites:
 *   - AWS credentials
 *   - npm, git, uv installed
 */
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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: dataset eval integration', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDsEval${String(Date.now()).slice(-8)}`;
  const datasetName = 'E2eEvalDataset';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-dataset-eval-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent (Strands, Bedrock, no memory)
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

  // ════════════════════════════════════════════════════════════════════════
  // Add dataset with predefined scenarios
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'adds a dataset with predefined scenarios',
    async () => {
      const result = await run([
        'add',
        'dataset',
        '--name',
        datasetName,
        '--schema-type',
        'AGENTCORE_EVALUATION_PREDEFINED_V1',
        '--description',
        'E2E dataset for eval integration test',
        '--json',
      ]);

      expect(result.exitCode, `Add dataset failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; datasetName: string };
      expect(json.success).toBe(true);
      expect(json.datasetName).toBe(datasetName);

      // Write 3 simple evaluation scenarios
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);
      const examples = [
        '{"scenario_id": "greeting", "turns": [{"input": "Hello, how are you?", "expectedResponse": "I am doing well, thank you!"}]}',
        '{"scenario_id": "math", "turns": [{"input": "What is 2+2?", "expectedResponse": "4"}]}',
        '{"scenario_id": "weather", "turns": [{"input": "What is the weather like?", "expectedResponse": "I cannot check the weather, but I can help with other questions."}]}',
      ];
      await writeFile(datasetFile, examples.join('\n') + '\n', 'utf-8');
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Deploy agent + dataset
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploys agent with dataset',
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

  // ════════════════════════════════════════════════════════════════════════
  // Wait for agent readiness (invoke with retry)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'agent is invocable after deploy',
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

  // ════════════════════════════════════════════════════════════════════════
  // Run eval with --dataset flag using Builtin evaluator
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs evaluation using dataset as input',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'eval',
            '--runtime',
            agentName,
            '--dataset',
            datasetName,
            '--evaluator',
            'Builtin.Faithfulness',
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
