/**
 * E2E tests for the archive command.
 *
 * Flow: create project → deploy → invoke → run batch-eval → run recommendation →
 *       archive batch-eval (verify service delete + local .cli cleared) →
 *       archive recommendation (verify service delete + local .cli cleared)
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
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: archive command lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eArch${String(Date.now()).slice(-8)}`;

  // IDs captured from run steps and used in archive steps
  let batchEvaluationId: string;
  let recommendationId: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-archive-${randomUUID()}`);
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

  // ════════════════════════════════════════════════════════════════════════
  // Setup — deploy and generate traces
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploys the agent',
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
  // Batch evaluation — run and capture ID
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs batch evaluation and captures the ID',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'batch-evaluation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--lookback-days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `batch-evaluation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(
            0
          );
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json.batchEvaluationId).toBeTruthy();
          expect(json.status).not.toBe('FAILED');
          batchEvaluationId = json.batchEvaluationId as string;
        },
        6,
        15000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'local .cli/batch-eval-results contains the run record',
    () => {
      expect(batchEvaluationId, 'batchEvaluationId should have been captured').toBeTruthy();
      const filePath = join(projectPath, 'agentcore', '.cli', 'batch-eval-results', `${batchEvaluationId}.json`);
      expect(existsSync(filePath), `Expected local record at ${filePath}`).toBe(true);
    },
    30000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Recommendation — run and capture ID
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs a recommendation and captures the ID',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--inline',
            'You are a helpful assistant for testing.',
            '--lookback',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `recommendation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json.recommendationId).toBeTruthy();
          recommendationId = json.recommendationId as string;
        },
        6,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'local .cli/recommendations contains the run record',
    () => {
      expect(recommendationId, 'recommendationId should have been captured').toBeTruthy();
      const filePath = join(projectPath, 'agentcore', '.cli', 'recommendations', `${recommendationId}.json`);
      expect(existsSync(filePath), `Expected local record at ${filePath}`).toBe(true);
    },
    30000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Archive batch evaluation
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'archive batch-evaluation fails without --id flag',
    async () => {
      const result = await run(['archive', 'batch-evaluation']);
      expect(result.exitCode).not.toBe(0);
    },
    30000
  );

  it.skipIf(!canRun)(
    'archives the batch evaluation with --json flag',
    async () => {
      expect(batchEvaluationId, 'batchEvaluationId must have been captured').toBeTruthy();

      const result = await run(['archive', 'batch-evaluation', '--id', batchEvaluationId, '--json']);
      expect(result.exitCode, `archive batch-evaluation failed: ${result.stderr}\n${result.stdout}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json.batchEvaluationId).toBe(batchEvaluationId);
      expect(json).toHaveProperty('localCliHistoryDeleted', true);
      expect(json.localDeleteWarning).toBeUndefined();
    },
    120000
  );

  it.skipIf(!canRun)(
    'local .cli/batch-eval-results no longer contains the archived record',
    () => {
      const filePath = join(projectPath, 'agentcore', '.cli', 'batch-eval-results', `${batchEvaluationId}.json`);
      expect(existsSync(filePath), `Local record should have been deleted from ${filePath}`).toBe(false);
    },
    30000
  );

  it.skipIf(!canRun)(
    'evals history does not surface the archived batch evaluation ID',
    async () => {
      // evals history lists on-demand (run eval) records — batch evals are stored separately.
      // Verify: the command succeeds and contains no entry matching our batch evaluation ID.
      const result = await run(['evals', 'history', '--json']);
      expect(result.exitCode, `evals history failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { runs?: { agent: string }[] };
      const output = JSON.stringify(json.runs ?? []);
      expect(output).not.toContain(batchEvaluationId);
    },
    60000
  );

  it.skipIf(!canRun)(
    'archiving the same batch evaluation again returns success false (already deleted)',
    async () => {
      const result = await run(['archive', 'batch-evaluation', '--id', batchEvaluationId, '--json']);
      // Service should return an error (resource not found / already deleted)
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toBeTruthy();
    },
    120000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Archive recommendation
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'archive recommendation fails without --id flag',
    async () => {
      const result = await run(['archive', 'recommendation']);
      expect(result.exitCode).not.toBe(0);
    },
    30000
  );

  it.skipIf(!canRun)(
    'archives the recommendation with --json flag',
    async () => {
      expect(recommendationId, 'recommendationId must have been captured').toBeTruthy();

      const result = await run(['archive', 'recommendation', '--id', recommendationId, '--json']);
      expect(result.exitCode, `archive recommendation failed: ${result.stderr}\n${result.stdout}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json.recommendationId).toBe(recommendationId);
      expect(json).toHaveProperty('localCliHistoryDeleted', true);
      expect(json.localDeleteWarning).toBeUndefined();
    },
    120000
  );

  it.skipIf(!canRun)(
    'local .cli/recommendations no longer contains the archived record',
    () => {
      const filePath = join(projectPath, 'agentcore', '.cli', 'recommendations', `${recommendationId}.json`);
      expect(existsSync(filePath), `Local record should have been deleted from ${filePath}`).toBe(false);
    },
    30000
  );

  it.skipIf(!canRun)(
    'recommendations history no longer includes the archived entry',
    async () => {
      const result = await run(['recommendations', 'history', '--json']);
      expect(result.exitCode, `recommendations history failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { recommendations: { recommendationId: string }[] };
      const ids = (json.recommendations ?? []).map(r => r.recommendationId);
      expect(ids).not.toContain(recommendationId);
    },
    60000
  );

  it.skipIf(!canRun)(
    'archiving the same recommendation again returns success false (already deleted)',
    async () => {
      const result = await run(['archive', 'recommendation', '--id', recommendationId, '--json']);
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toBeTruthy();
    },
    120000
  );
});
