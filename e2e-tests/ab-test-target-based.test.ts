/**
 * E2E test for A/B tests (target-based mode) across the AWS boundary.
 *
 * Target-based mode compares two gateway-targets (rather than two config-bundle
 * versions). Here both targets are http-runtime targets pointing at two named
 * endpoints of the same agent runtime, each scoped by its own online-eval.
 *
 * Flow: create project → add gateway → add two runtime endpoints (control,
 *       treatment) → add two http-runtime targets → add two online-evals
 *       (one per endpoint) → deploy → run ab-test --mode target-based →
 *       view (RUNNING) → pause (PAUSED) → resume (RUNNING) → promote (STOPPED) →
 *       archive
 *
 * Promote in target-based mode (same runtime, both named endpoints) bumps the
 * control endpoint's version to the treatment endpoint's — control keeps its
 * identity. A/B tests are jobs, not project resources, so cleanup archives the
 * test explicitly before teardown.
 *
 * Prerequisites: AWS credentials, npm, git, uv.
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

describe.sequential('e2e: A/B test lifecycle (target-based mode)', () => {
  let testDir: string;
  let projectPath: string;
  const suffix = String(Date.now()).slice(-8);
  const agentName = `E2eAbtTb${suffix}`;
  const gatewayName = 'abttbgw';
  const controlTarget = 'ctrlTarget';
  const treatmentTarget = 'treatTarget';
  const controlEndpoint = 'control';
  const treatmentEndpoint = 'treatment';
  const controlEval = 'E2eAbtTbCtrlEval';
  const treatmentEval = 'E2eAbtTbTreatEval';
  const abTestName = 'E2eAbtTbTest';

  let abTestId: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-ab-test-tb-${randomUUID()}`);
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
    // A/B tests are jobs, not project resources — archive explicitly before teardown.
    if (abTestId && projectPath && hasAws) {
      await runAgentCoreCLI(['archive', 'ab-test', '-i', abTestId, '--json'], projectPath);
    }
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  const assertSuccess = async (args: string[], label: string): Promise<void> => {
    const result = await run(args);
    expect(result.exitCode, `${label} failed: ${result.stdout}\n${result.stderr}`).toBe(0);
    expect((parseJsonOutput(result.stdout) as { success: boolean }).success, `${label} should succeed`).toBe(true);
  };

  // ── Gateway + two named endpoints on the agent runtime ───────────────────

  it.skipIf(!canRun)('adds an HTTP gateway', () =>
    assertSuccess(['add', 'gateway', '--name', gatewayName, '--protocol-type', 'None', '--json'], 'add gateway')
  );

  it.skipIf(!canRun)('adds two runtime endpoints (control, treatment)', async () => {
    await assertSuccess(
      ['add', 'runtime-endpoint', '--runtime', agentName, '--endpoint', controlEndpoint, '--version', '1', '--json'],
      'add control endpoint'
    );
    await assertSuccess(
      ['add', 'runtime-endpoint', '--runtime', agentName, '--endpoint', treatmentEndpoint, '--version', '1', '--json'],
      'add treatment endpoint'
    );
  });

  // ── Two http-runtime targets, one per endpoint ───────────────────────────

  it.skipIf(!canRun)('adds the control http-runtime target', () =>
    assertSuccess(
      [
        'add',
        'gateway-target',
        '--gateway',
        gatewayName,
        '--name',
        controlTarget,
        '--type',
        'http-runtime',
        '--runtime',
        agentName,
        '--runtime-endpoint',
        controlEndpoint,
        '--json',
      ],
      'add control target'
    )
  );

  it.skipIf(!canRun)('adds the treatment http-runtime target', () =>
    assertSuccess(
      [
        'add',
        'gateway-target',
        '--gateway',
        gatewayName,
        '--name',
        treatmentTarget,
        '--type',
        'http-runtime',
        '--runtime',
        agentName,
        '--runtime-endpoint',
        treatmentEndpoint,
        '--json',
      ],
      'add treatment target'
    )
  );

  // ── One online-eval per endpoint (target-based requires per-variant evals) ─

  it.skipIf(!canRun)('adds two online-eval configs, one per endpoint', async () => {
    await assertSuccess(
      [
        'add',
        'online-eval',
        '--name',
        controlEval,
        '--runtime',
        agentName,
        '--endpoint',
        controlEndpoint,
        '--evaluator',
        'Builtin.Faithfulness',
        '--sampling-rate',
        '100',
        '--json',
      ],
      'add control online-eval'
    );
    await assertSuccess(
      [
        'add',
        'online-eval',
        '--name',
        treatmentEval,
        '--runtime',
        agentName,
        '--endpoint',
        treatmentEndpoint,
        '--evaluator',
        'Builtin.Faithfulness',
        '--sampling-rate',
        '100',
        '--json',
      ],
      'add treatment online-eval'
    );
  });

  // ── Deploy everything in one stack ───────────────────────────────────────

  it.skipIf(!canRun)(
    'deploys the runtime, gateway, targets, and online-evals',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);
      if (result.exitCode !== 0) console.log('Deploy stdout/stderr:', result.stdout, result.stderr);
      expect(result.exitCode, `Deploy failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
    },
    900000
  );

  // ── Create the target-based A/B test ─────────────────────────────────────

  it.skipIf(!canRun)(
    'runs the A/B test in target-based mode',
    async () => {
      let runJson: { mode: string; variants: { name: string; targetName?: string }[] } | undefined;
      await retry(
        async () => {
          const result = await run([
            'run',
            'ab-test',
            '-n',
            abTestName,
            '-g',
            gatewayName,
            '--mode',
            'target-based',
            '--control-target',
            controlTarget,
            '--treatment-target',
            treatmentTarget,
            '--control-online-eval',
            controlEval,
            '--treatment-online-eval',
            treatmentEval,
            '--runtime',
            agentName,
            '--json',
          ]);

          if (result.exitCode !== 0) console.log('run ab-test stdout/stderr:', result.stdout, result.stderr);
          expect(result.exitCode, `run ab-test failed: ${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as {
            success: boolean;
            id: string;
            mode: string;
            variants: { name: string; targetName?: string }[];
          };
          expect(json.success).toBe(true);
          expect(json.id).toBeTruthy();
          // Capture the id immediately so afterAll always archives the test, even if a
          // later assertion fails. Done inside retry (before any throw) so an orphan is
          // never left behind by a re-attempt.
          abTestId = json.id;
          runJson = json;
        },
        3,
        20000
      );
      // Deterministic checks live outside retry — a mismatch must not re-create the test.
      expect(runJson!.mode).toBe('target-based');
      expect(runJson!.variants).toHaveLength(2);
    },
    300000
  );

  // ── pause / resume / promote — live execution state from AWS ─────────────

  const viewExecutionStatus = async (): Promise<string> => {
    const result = await run(['view', 'ab-test', abTestId, '--json']);
    expect(result.exitCode, `view ab-test failed: ${result.stderr}`).toBe(0);
    // Live execution status (RUNNING/PAUSED/STOPPED) surfaces in lifecycleStatus.
    return (parseJsonOutput(result.stdout) as { lifecycleStatus: string }).lifecycleStatus;
  };

  it.skipIf(!canRun)(
    'view reports the test reaching RUNNING',
    async () => {
      expect(abTestId, 'AB test ID should have been captured').toBeTruthy();
      await retry(async () => expect(await viewExecutionStatus()).toBe('RUNNING'), 12, 10000);
    },
    180000
  );

  it.skipIf(!canRun)(
    'pause sets live execution state to PAUSED',
    async () => {
      await assertSuccess(['pause', 'ab-test', '-i', abTestId, '--json'], 'pause');
      await retry(async () => expect(await viewExecutionStatus()).toBe('PAUSED'), 6, 10000);
    },
    120000
  );

  it.skipIf(!canRun)(
    'resume sets live execution state back to RUNNING',
    async () => {
      await assertSuccess(['resume', 'ab-test', '-i', abTestId, '--json'], 'resume');
      await retry(async () => expect(await viewExecutionStatus()).toBe('RUNNING'), 6, 10000);
    },
    120000
  );

  it.skipIf(!canRun)(
    'promote stops the test and applies the winning target to config',
    async () => {
      // promote waits for RUNNING (up to ~120s), stops the test, then promotes the
      // control endpoint to the treatment endpoint's version in agentcore.json.
      const result = await run(['promote', 'ab-test', '-i', abTestId, '--json']);
      if (result.exitCode !== 0) console.log('promote stdout/stderr:', result.stdout, result.stderr);
      expect(result.exitCode, `promote failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean; id: string }).success).toBe(true);

      await retry(async () => expect(await viewExecutionStatus()).toBe('STOPPED'), 6, 10000);
    },
    180000
  );
});
