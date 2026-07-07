/**
 * E2E test for A/B tests (config-bundle mode) across the AWS boundary.
 *
 * Flow: create project → add gateway → add config bundle (v1) → deploy →
 *       update bundle (v2) → deploy → add online-eval (Builtin evaluator) → deploy →
 *       run ab-test → view (poll RUNNING) → pause → view (PAUSED) → resume →
 *       view (RUNNING) → promote → archive
 *
 * A/B tests are fire-and-forget jobs, not project resources, so cleanup must
 * `archive` the test explicitly — `remove all` does not touch it.
 *
 * Live-AWS behaviours this proves (per e2e-tests/README.md): pause / resume /
 * promote return live execution state from AWS. `view ab-test --json` re-fetches
 * server state; the live execution status (RUNNING/PAUSED/STOPPED) surfaces in
 * the `lifecycleStatus` field (handler.refresh maps executionStatus → lifecycleStatus).
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

describe.sequential('e2e: A/B test lifecycle (config-bundle mode)', () => {
  let testDir: string;
  let projectPath: string;
  const suffix = String(Date.now()).slice(-8);
  const agentName = `E2eAbt${suffix}`;
  const gatewayName = 'abtgw';
  const bundleName = 'E2eAbtBundle';
  const onlineEvalName = 'E2eAbtEval';
  const abTestName = 'E2eAbtTest';

  // Captured across the sequential steps.
  let controlVersionId: string;
  let abTestId: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-ab-test-${randomUUID()}`);
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

  const bundleComponents = (systemPrompt: string, temperature: number) =>
    JSON.stringify({
      [`{{runtime:${agentName}}}`]: { configuration: { systemPrompt, temperature } },
    });

  // ── Gateway (required: AB tests resolve a deployed gateway ARN) ──────────

  it.skipIf(!canRun)(
    'adds a gateway',
    async () => {
      const result = await run(['add', 'gateway', '--name', gatewayName, '--protocol-type', 'None', '--json']);
      expect(result.exitCode, `Add gateway failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
    },
    60000
  );

  // ── Config bundle v1 + deploy ────────────────────────────────────────────

  it.skipIf(!canRun)(
    'adds config bundle (v1) and deploys',
    async () => {
      const add = await run([
        'add',
        'config-bundle',
        '--name',
        bundleName,
        '--description',
        'AB test bundle',
        '--components',
        bundleComponents('You are control: concise.', 0.5),
        '--branch',
        'mainline',
        '--commit-message',
        'v1 control',
        '--json',
      ]);
      expect(add.exitCode, `Add config-bundle failed: ${add.stdout}`).toBe(0);
      expect((parseJsonOutput(add.stdout) as { success: boolean }).success).toBe(true);

      const deploy = await run(['deploy', '--yes', '--json']);
      if (deploy.exitCode !== 0) console.log('Deploy v1 stdout/stderr:', deploy.stdout, deploy.stderr);
      expect(deploy.exitCode, 'Deploy v1 failed').toBe(0);
      expect((parseJsonOutput(deploy.stdout) as { success: boolean }).success).toBe(true);
    },
    600000
  );

  // ── Config bundle v2 (remove + re-add same name + redeploy = version bump) ─

  it.skipIf(!canRun)(
    'updates config bundle to v2 (second version of the same bundle) and deploys',
    async () => {
      let result = await run(['remove', 'config-bundle', '--name', bundleName, '--json']);
      expect(result.exitCode, `Remove config-bundle failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'config-bundle',
        '--name',
        bundleName,
        '--description',
        'AB test bundle - treatment',
        '--components',
        bundleComponents('You are treatment: detailed and thorough.', 0.9),
        '--branch',
        'mainline',
        '--commit-message',
        'v2 treatment',
        '--json',
      ]);
      expect(result.exitCode, `Re-add config-bundle failed: ${result.stdout}`).toBe(0);

      result = await run(['deploy', '--yes', '--json']);
      expect(result.exitCode, `Redeploy failed: ${result.stdout}`).toBe(0);
    },
    600000
  );

  it.skipIf(!canRun)(
    'config-bundle versions lists both versions (captures control = oldest)',
    async () => {
      const result = await run(['config-bundle', 'versions', '--name', bundleName, '--json']);
      expect(result.exitCode, `cb versions failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { versions: { versionId: string }[] };
      expect(json.versions.length).toBeGreaterThanOrEqual(2);
      // Versions are newest-first; oldest is the control (treatment uses LATEST).
      controlVersionId = json.versions[json.versions.length - 1]!.versionId;
      expect(controlVersionId).toBeTruthy();
    },
    120000
  );

  // ── Online-eval (Builtin evaluator — no custom evaluator resource needed) ──

  it.skipIf(!canRun)(
    'adds an online-eval config and deploys',
    async () => {
      const add = await run([
        'add',
        'online-eval',
        '--name',
        onlineEvalName,
        '--runtime',
        agentName,
        '--evaluator',
        'Builtin.Faithfulness',
        '--sampling-rate',
        '100',
        '--json',
      ]);
      expect(add.exitCode, `Add online-eval failed: ${add.stdout}`).toBe(0);
      const addJson = parseJsonOutput(add.stdout) as { success: boolean; configName: string };
      expect(addJson.success).toBe(true);
      expect(addJson.configName).toBe(onlineEvalName);

      const deploy = await run(['deploy', '--yes', '--json']);
      if (deploy.exitCode !== 0) console.log('Deploy eval stdout/stderr:', deploy.stdout, deploy.stderr);
      expect(deploy.exitCode, 'Deploy online-eval failed').toBe(0);
      expect((parseJsonOutput(deploy.stdout) as { success: boolean }).success).toBe(true);
    },
    600000
  );

  // ── Create the A/B test ───────────────────────────────────────────────────

  it.skipIf(!canRun)(
    'runs the A/B test (control = oldest version, treatment = LATEST)',
    async () => {
      expect(controlVersionId, 'Control version should have been captured').toBeTruthy();

      // Auto-creates an IAM role and retries on AccessDenied while IAM propagates;
      // retry the whole call to absorb propagation flakiness.
      let runJson: { mode: string; variants: { name: string }[] } | undefined;
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
            'config-bundle',
            '--control-bundle',
            bundleName,
            '--control-version',
            controlVersionId,
            '--treatment-bundle',
            bundleName,
            '--treatment-version',
            'LATEST',
            '--online-eval',
            onlineEvalName,
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
            variants: { name: string }[];
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
      expect(runJson!.mode).toBe('config-bundle');
      expect(runJson!.variants).toHaveLength(2);
    },
    300000
  );

  // ── pause / resume / promote — live execution state from AWS ───────────────

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
      await retry(
        async () => {
          expect(await viewExecutionStatus()).toBe('RUNNING');
        },
        12,
        10000
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'pause sets live execution state to PAUSED',
    async () => {
      const result = await run(['pause', 'ab-test', '-i', abTestId, '--json']);
      expect(result.exitCode, `pause failed: ${result.stderr}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean; id: string }).success).toBe(true);

      await retry(async () => expect(await viewExecutionStatus()).toBe('PAUSED'), 6, 10000);
    },
    120000
  );

  it.skipIf(!canRun)(
    'resume sets live execution state back to RUNNING',
    async () => {
      const result = await run(['resume', 'ab-test', '-i', abTestId, '--json']);
      expect(result.exitCode, `resume failed: ${result.stderr}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);

      await retry(async () => expect(await viewExecutionStatus()).toBe('RUNNING'), 6, 10000);
    },
    120000
  );

  it.skipIf(!canRun)(
    'promote stops the test and applies the winning variant to config',
    async () => {
      // promote waits for RUNNING (up to ~120s), stops the test, rewrites the bundle.
      const result = await run(['promote', 'ab-test', '-i', abTestId, '--json']);
      if (result.exitCode !== 0) console.log('promote stdout/stderr:', result.stdout, result.stderr);
      expect(result.exitCode, `promote failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean; id: string }).success).toBe(true);

      await retry(async () => expect(await viewExecutionStatus()).toBe('STOPPED'), 6, 10000);
    },
    180000
  );
});
