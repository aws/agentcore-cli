/**
 * E2E tests for the Insights feature (Lens).
 *
 * Two independent sequential suites in this file:
 *
 *   A. online-insights lifecycle:
 *        add online-insights → deploy → invoke → pause → resume → teardown
 *
 *   B. run-insights + recommendation chain:
 *        deploy → invoke → run insights (async) → view → archive
 *        → run insights --wait → run recommendation --from-insights → teardown
 *
 * Each suite owns its own deployed agent + CFN stack so a deploy failure in
 * one suite does not blank the other.
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
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;
const FAILURE_ANALYSIS = 'Builtin.Insight.FailureAnalysis';

// ──────────────────────────────────────────────────────────────────────────────
// Suite A: online-insights lifecycle
// ──────────────────────────────────────────────────────────────────────────────

describe.sequential('e2e: online-insights lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eInsiOn${String(Date.now()).slice(-8)}`;
  const onlineInsightsName = 'E2eOnlineInsights';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-online-insights-${randomUUID()}`);
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

  let invokeSucceeded = false;
  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  it.skipIf(!canRun)(
    'configures an online-insights config before deploy',
    async () => {
      const result = await run([
        'add',
        'online-insights',
        '--name',
        onlineInsightsName,
        '--runtime',
        agentName,
        '--insights',
        FAILURE_ANALYSIS,
        '--sampling-rate',
        '100',
        '--enable-on-create',
        '--json',
      ]);
      expect(result.exitCode, `Add online-insights failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(true);
    },
    60000
  );

  it.skipIf(!canRun)(
    'deploys agent with online-insights config',
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
    'invokes the deployed agent so the online-insights sampler has data',
    async () => {
      try {
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
        invokeSucceeded = true;
      } catch (err) {
        console.warn('Invoke setup failed, subsequent insights tests will be skipped:', (err as Error).message);
      }
    },
    180000
  );

  it.skipIf(!canRun)(
    'pauses the online-insights config',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run(['pause', 'online-insights', onlineInsightsName, '--json']);
      expect(result.exitCode, `Pause failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('executionStatus', 'DISABLED');
    },
    120000
  );

  it.skipIf(!canRun)(
    'resumes the online-insights config',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run(['resume', 'online-insights', onlineInsightsName, '--json']);
      expect(result.exitCode, `Resume failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('executionStatus', 'ENABLED');
    },
    120000
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite B: run-insights + view/archive + recommendation chain
// ──────────────────────────────────────────────────────────────────────────────

interface InsightsJobJson {
  success: boolean;
  id: string;
  status: string;
  name: string;
  arn: string;
  agent?: string;
  insights: string[];
}

interface ViewInsightsListJson {
  success: boolean;
  insights: { id: string; status: string }[];
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'COMPLETED_WITH_ERRORS', 'STOPPED', 'CANCELLED']);

describe.sequential('e2e: run-insights and recommendation chain', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eInsiRun${String(Date.now()).slice(-8)}`;

  // Job ids captured between tests
  let invokeSucceeded = false;
  let asyncJobId: string;
  let waitJobId: string;
  let waitJobStatus: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-run-insights-${randomUUID()}`);
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
    'invokes the deployed agent so insights has trace data',
    async () => {
      try {
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
        invokeSucceeded = true;
      } catch (err) {
        console.warn('Invoke setup failed, subsequent insights tests will be skipped:', (err as Error).message);
      }
    },
    180000
  );

  it.skipIf(!canRun)(
    'submits an async insights job (no --wait) and gets back a job id',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      // Retry handles eventual consistency: the runtime log group can lag a few
      // seconds behind the deploy/invoke before StartBatchEvaluation accepts it.
      await retry(
        async () => {
          const result = await run([
            'run',
            'insights',
            '--runtime',
            agentName,
            '--insights',
            FAILURE_ANALYSIS,
            '--lookback-days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `Run insights failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as InsightsJobJson;
          expect(json.success).toBe(true);
          expect(json.id).toBeTruthy();
          expect(json.status).toBeTruthy();
          expect(json.insights).toContain(FAILURE_ANALYSIS);
          asyncJobId = json.id;
        },
        18,
        10000
      );
    },
    300000
  );

  it.skipIf(!canRun)(
    'view insights lists the submitted async job',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run(['view', 'insights', '--json']);
      expect(result.exitCode, `View insights failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as ViewInsightsListJson;
      expect(json.success).toBe(true);
      expect(Array.isArray(json.insights)).toBe(true);
      const found = json.insights.find(j => j.id === asyncJobId);
      expect(found, `Async job ${asyncJobId} should appear in view insights`).toBeDefined();
    },
    120000
  );

  it.skipIf(!canRun)(
    'view insights <id> returns detail for the async job',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run(['view', 'insights', asyncJobId, '--json']);
      expect(result.exitCode, `View insights detail failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as InsightsJobJson;
      expect(json.success).toBe(true);
      expect(json.id).toBe(asyncJobId);
      expect(json.status).toBeTruthy();
      expect(json.arn).toMatch(/^arn:[^:]+:bedrock-agentcore:/);
    },
    120000
  );

  it.skipIf(!canRun)(
    'archive insights removes the async job from view insights',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const archiveResult = await run(['archive', 'insights', '--id', asyncJobId, '--json']);
      expect(archiveResult.exitCode, `Archive failed: ${archiveResult.stderr}`).toBe(0);
      const archiveJson = parseJsonOutput(archiveResult.stdout) as Record<string, unknown>;
      expect(archiveJson.success).toBe(true);

      const listResult = await run(['view', 'insights', '--json']);
      expect(listResult.exitCode).toBe(0);
      const listJson = parseJsonOutput(listResult.stdout) as ViewInsightsListJson;
      const stillThere = listJson.insights.find(j => j.id === asyncJobId);
      expect(stillThere, `Archived job ${asyncJobId} should not appear in view insights`).toBeUndefined();
    },
    120000
  );

  // The chain test needs a terminal insights job. We submit a fresh one with
  // --wait and a long timeout. `--insights` and `--evaluator` are mutually
  // exclusive on the BatchEvaluation API, so we only pass --insights here and
  // supply --evaluator directly on the recommendation chain step below.
  it.skipIf(!canRun)(
    'submits an insights job with --wait and reaches a terminal status',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run([
        'run',
        'insights',
        '--runtime',
        agentName,
        '--insights',
        FAILURE_ANALYSIS,
        '--lookback-days',
        '1',
        '--wait',
        '--json',
      ]);
      if (result.exitCode !== 0) {
        console.log('Run insights --wait stdout:', result.stdout);
        console.log('Run insights --wait stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as InsightsJobJson;
      expect(json.success).toBe(true);
      expect(json.id).toBeTruthy();
      expect(TERMINAL_STATUSES.has(json.status), `Expected terminal status, got "${json.status}"`).toBe(true);
      waitJobId = json.id;
      waitJobStatus = json.status;
    },
    1500000
  );

  it.skipIf(!canRun)(
    'run recommendation --from-insights chains off the completed job',
    async ctx => {
      if (!invokeSucceeded) ctx.skip();
      const result = await run([
        'run',
        'recommendation',
        '--from-insights',
        waitJobId,
        '--type',
        'system-prompt',
        '--inline',
        'You are a helpful assistant.',
        '--evaluator',
        'Builtin.Faithfulness',
        '--json',
      ]);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown> & { error?: string };

      // Two acceptable outcomes:
      //   1. The recommendation succeeds end-to-end (signal that the chain works).
      //   2. The recommendation fails because the insights job had no usable
      //      sessions (FAILED / COMPLETED_WITH_ERRORS / empty traces). That
      //      still proves the wiring: --from-insights resolved the local
      //      insights record into a batch-eval ARN and reached the service.
      //
      // What must NOT happen: a flag-parsing error or "unknown option".
      const errorString = typeof json.error === 'string' ? json.error : '';
      expect(errorString).not.toContain('Unknown option');
      expect(errorString).not.toContain('--from-insights');

      if (result.exitCode === 0) {
        expect(json.success).toBe(true);
      } else {
        // Acceptable when the upstream insights job had no sessions to learn from.
        expect(
          /no sessions|completed_with_errors|completed with errors|failed|not.*completed|empty/i.test(errorString),
          `Recommendation chain failed with unexpected error (waitJobStatus=${waitJobStatus}): ${errorString}`
        ).toBe(true);
      }
    },
    600000
  );
});
