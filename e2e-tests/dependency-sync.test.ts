import { parseJsonOutput, spawnAndCollect } from '../src/test-utils/index.js';
import {
  baseCanRun as canRun,
  hasAws,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { dumpFailureContext } from './utils/failure-context.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * E2E tests for the managed-dependency sync deploy preflight.
 *
 * The unit tests in src/lib/dependency-management/__tests__/ cover the sync logic with the npm
 * subprocess mocked. These tests exercise the wiring through the real CLI binary — option
 * passing, JSON envelope shape, exit codes — and (test 1 only) a REAL `npm install` against a
 * real node_modules, surviving a real CDK deploy. Only test 1 creates a stack; tests 2-4 stop
 * before any CloudFormation work happens.
 *
 * Each suite is fully independent (own project, own beforeAll/afterAll) per the e2e convention.
 */

/** The managed dependency these tests manipulate. Verified against the vended manifest at runtime. */
const MANAGED_DEP = 'constructs';
/** Second managed dep migrated in test 1 (also tilde-pinned in the vended asset). */
const SECOND_MANAGED_DEP = 'aws-cdk-lib';
/** User-owned dependency the sync must never touch. */
const USER_DEP = 'lodash';
const USER_DEP_SPEC = '^4.17.21';

/** Shape of the dependency-sync outcome inside the `deploy --json` envelope (DependencySyncResult). */
interface DepSyncJson {
  outcome: 'synced' | 'check-only' | 'opted-out' | 'skipped' | 'failure-suppressed' | 'failed';
  optedOut: boolean;
  checkOnly: boolean;
  migratedFromCaret: boolean;
  reinstalled: boolean;
  skewWarning: boolean;
  changes: { name: string; section: string; from: string; to: string }[];
  restored: { name: string; section: string; to: string }[];
  skipped: { name: string; raw: string; reason: string }[];
  warnings: string[];
  notice: string | null;
}

interface DeployJsonEnvelope {
  success: boolean;
  error?: string;
  errorName?: string;
  dependencySyncResult?: DepSyncJson;
}

interface CdkManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function cdkPackageJsonPath(projectPath: string): string {
  return join(projectPath, 'agentcore', 'cdk', 'package.json');
}

async function readCdkManifest(projectPath: string): Promise<{ manifest: CdkManifest; raw: string }> {
  const raw = await readFile(cdkPackageJsonPath(projectPath), 'utf-8');
  return { manifest: JSON.parse(raw) as CdkManifest, raw };
}

/** Read-modify-write one dependency specifier in agentcore/cdk/package.json. */
async function setManagedDepVersion(projectPath: string, name: string, spec: string): Promise<void> {
  const { manifest } = await readCdkManifest(projectPath);
  manifest.dependencies ??= {};
  manifest.dependencies[name] = spec;
  await writeFile(cdkPackageJsonPath(projectPath), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/** Extract the base major.minor.patch from a tilde/caret/exact specifier. */
function baseVersionOf(spec: string): { major: number; minor: number; patch: number } {
  const match = /^[~^]?(\d+)\.(\d+)\.(\d+)/.exec(spec);
  if (!match) throw new Error(`Cannot parse managed dependency specifier "${spec}"`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** A version strictly lower than the given spec's base — a routine in-range upgrade, never skew. */
function lowerVersionOf(spec: string): string {
  const v = baseVersionOf(spec);
  if (v.patch > 0) return `${v.major}.${v.minor}.${v.patch - 1}`;
  if (v.minor > 0) return `${v.major}.${v.minor - 1}.0`;
  return `${v.major - 1}.0.0`;
}

/** A higher-minor version than the given spec's base — the newer-than-CLI skew case. */
function higherMinorVersionOf(spec: string): string {
  const v = baseVersionOf(spec);
  return `${v.major}.${v.minor + 2}.0`;
}

/** Rewrite any specifier to a caret range over the same base (simulates a pre-pinning project). */
function toCaret(spec: string): string {
  return `^${spec.replace(/^[~^]/, '')}`;
}

/**
 * Scaffold a real project the way createE2ESuite does: `create` → write aws-targets.json →
 * install the CDK tarball override when CDK_TARBALL is set (CI builds).
 */
async function scaffoldProject(testDir: string, agentName: string): Promise<string> {
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
  expect(result.exitCode, `Create failed: stderr=${result.stderr}\n\nstdout=${result.stdout}`).toBe(0);
  const json = parseJsonOutput(result.stdout) as { projectPath: string };
  await writeAwsTargets(json.projectPath);
  installCdkTarball(json.projectPath);
  return json.projectPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — caret migration + real npm install + user-dep preservation
// The only test in this suite that performs a full real deploy (and destroy).
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential('e2e: dependency sync — caret migration survives a real deploy', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDepSyncMig${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let vendedManagedSpec: string;
  let vendedSecondSpec: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-depsync-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    projectPath = await scaffoldProject(testDir, agentName);

    // Capture the vended specifiers BEFORE editing — they are the sync's source of truth.
    const { manifest } = await readCdkManifest(projectPath);
    vendedManagedSpec = manifest.dependencies?.[MANAGED_DEP] ?? '';
    vendedSecondSpec = manifest.dependencies?.[SECOND_MANAGED_DEP] ?? '';
    expect(vendedManagedSpec, `${MANAGED_DEP} should be a managed (vended) dependency`).toMatch(/^~/);
    expect(vendedSecondSpec, `${SECOND_MANAGED_DEP} should be a managed (vended) dependency`).toMatch(/^~/);

    // Simulate a pre-pinning project: caret ranges on managed deps (one on a lower base,
    // one on the same base) plus a user-owned dependency the CLI doesn't manage.
    await setManagedDepVersion(projectPath, MANAGED_DEP, `^${lowerVersionOf(vendedManagedSpec)}`);
    await setManagedDepVersion(projectPath, SECOND_MANAGED_DEP, toCaret(vendedSecondSpec));
    await setManagedDepVersion(projectPath, USER_DEP, USER_DEP_SPEC);
  }, 300000);

  // Always destroy AWS resources — never skip this
  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  it.skipIf(!canRun)(
    'migrates caret pins, reinstalls, preserves user deps, and deploys',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      if (result.exitCode !== 0) {
        await dumpFailureContext({
          label: 'deploy (dependency-sync migration)',
          result,
          cwd: projectPath,
          stackName: `AgentCore-${agentName}-default`,
        });
      }
      expect(result.exitCode, `Deploy failed (stderr: ${result.stderr}, stdout: ${result.stdout})`).toBe(0);

      const json = parseJsonOutput(result.stdout) as DeployJsonEnvelope;
      expect(json.success, 'Deploy should report success').toBe(true);

      // The sync outcome rides on the JSON envelope as dependencySyncResult.
      const sync = json.dependencySyncResult;
      expect(sync, 'Deploy result should carry dependencySyncResult').toBeDefined();
      expect(sync!.migratedFromCaret, 'Caret ranges should be detected as a pre-pinning migration').toBe(true);
      expect(sync!.reinstalled, 'npm install should have run to reconcile the rewritten manifest').toBe(true);
      expect(sync!.notice, 'Migration should produce a user-facing notice').toBeTruthy();
      const changedNames = sync!.changes.map(c => c.name);
      expect(changedNames).toContain(MANAGED_DEP);
      expect(changedNames).toContain(SECOND_MANAGED_DEP);

      // Managed deps are back on the vended specifiers — no more carets.
      const { manifest } = await readCdkManifest(projectPath);
      expect(manifest.dependencies?.[MANAGED_DEP]).toBe(vendedManagedSpec);
      expect(manifest.dependencies?.[SECOND_MANAGED_DEP]).toBe(vendedSecondSpec);

      // The user-owned dependency is untouched at its original range.
      expect(manifest.dependencies?.[USER_DEP]).toBe(USER_DEP_SPEC);

      // Spot-check the real installed tree: node_modules/constructs resolves within the pinned range.
      const installedRaw = await readFile(
        join(projectPath, 'agentcore', 'cdk', 'node_modules', MANAGED_DEP, 'package.json'),
        'utf-8'
      );
      const installed = baseVersionOf((JSON.parse(installedRaw) as { version: string }).version);
      const pinned = baseVersionOf(vendedManagedSpec);
      expect(installed.major, `${MANAGED_DEP} major should match the pinned range`).toBe(pinned.major);
      expect(installed.minor, `${MANAGED_DEP} minor should match the tilde-pinned range`).toBe(pinned.minor);
      expect(installed.patch, `${MANAGED_DEP} patch should satisfy the tilde-pinned range`).toBeGreaterThanOrEqual(
        pinned.patch
      );
    },
    600000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — in-range lower version becomes a routine upgrade, reported by --dry-run
// Cheap: reaches the sync step and synth, but never bootstraps or deploys.
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential('e2e: dependency sync — dry-run reports an in-range upgrade without writing', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDepSyncUp${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let vendedManagedSpec: string;
  let staleSpec: string;
  let rawAfterEdit: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-depsync-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    projectPath = await scaffoldProject(testDir, agentName);

    const { manifest } = await readCdkManifest(projectPath);
    vendedManagedSpec = manifest.dependencies?.[MANAGED_DEP] ?? '';
    expect(vendedManagedSpec, `${MANAGED_DEP} should be a managed (vended) dependency`).toMatch(/^~/);

    // Lower-than-vended base version: an ordinary upgrade on next deploy, NOT skew.
    staleSpec = `~${lowerVersionOf(vendedManagedSpec)}`;
    await setManagedDepVersion(projectPath, MANAGED_DEP, staleSpec);
    rawAfterEdit = (await readCdkManifest(projectPath)).raw;
  }, 300000);

  afterAll(async () => {
    // No stack was ever created — only the local project needs cleaning up.
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 30000);

  it.skipIf(!canRun)(
    'dry-run reports the pending version bump and leaves package.json unchanged',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runAgentCoreCLI(['deploy', '--dry-run', '--yes', '--json'], projectPath);
      expect(result.exitCode, `Dry-run failed (stderr: ${result.stderr}, stdout: ${result.stdout})`).toBe(0);

      const json = parseJsonOutput(result.stdout) as DeployJsonEnvelope;
      expect(json.success).toBe(true);

      const sync = json.dependencySyncResult;
      expect(sync, 'Dry-run result should carry dependencySyncResult').toBeDefined();
      expect(sync!.checkOnly, 'Preview mode should run the sync check-only').toBe(true);
      expect(sync!.reinstalled).toBe(false);
      expect(sync!.changes).toContainEqual({
        name: MANAGED_DEP,
        section: 'dependencies',
        from: staleSpec,
        to: vendedManagedSpec,
      });
      expect(sync!.notice, 'Dry-run should report the pending bump in the notice').toBeTruthy();
      expect(sync!.notice).toContain(staleSpec);
      expect(sync!.notice).toContain(vendedManagedSpec);

      // The whole preview-mode design hinges on this: --dry-run must never mutate the working tree.
      const { raw } = await readCdkManifest(projectPath);
      expect(raw, 'package.json must be untouched by --dry-run').toBe(rawAfterEdit);
    },
    300000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — newer-than-CLI skew blocks a real deploy with the upgrade-CLI error
// Cheap: CliVersionTooOldError is thrown inside the sync step itself, before the
// CDK build/synth ever run — no stack is created. Note this must be a REAL deploy
// (not --dry-run): preview mode deliberately downgrades skew to a warning, so the
// hard failure is only observable on a mutating deploy.
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential('e2e: dependency sync — newer-than-CLI skew fails fast with the upgrade error', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDepSyncSkw${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let rawAfterEdit: string;
  // Defensive: if the skew guard ever regresses and the deploy goes through, tear the stack down.
  let deployedUnexpectedly = false;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-depsync-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    projectPath = await scaffoldProject(testDir, agentName);

    const { manifest } = await readCdkManifest(projectPath);
    const vendedManagedSpec = manifest.dependencies?.[MANAGED_DEP] ?? '';
    expect(vendedManagedSpec, `${MANAGED_DEP} should be a managed (vended) dependency`).toMatch(/^~/);

    // Higher minor than the vended pin: the project was touched by a newer CLI.
    await setManagedDepVersion(projectPath, MANAGED_DEP, `~${higherMinorVersionOf(vendedManagedSpec)}`);
    rawAfterEdit = (await readCdkManifest(projectPath)).raw;
  }, 300000);

  afterAll(async () => {
    if (deployedUnexpectedly && projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  it.skipIf(!canRun)(
    'deploy exits 1 with the upgrade-CLI error and never writes package.json',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      deployedUnexpectedly = result.exitCode === 0;

      expect(result.exitCode, `Skewed deploy should fail (stdout: ${result.stdout})`).toBe(1);

      const json = parseJsonOutput(result.stdout) as DeployJsonEnvelope;
      expect(json.success).toBe(false);
      // Distinctive substrings from formatCliUpgradeError, not the full copy.
      expect(json.error).toContain('requires a newer version of the AgentCore CLI');
      expect(json.error).toContain(MANAGED_DEP);
      expect(json.errorName).toBe('CliVersionTooOldError');
      // The failure envelope still carries the sync outcome (dep_sync_* telemetry rides on it).
      expect(json.dependencySyncResult?.outcome).toBe('failed');

      // Skew is detected before anything is written — the manifest must be untouched.
      const { raw } = await readCdkManifest(projectPath);
      expect(raw, 'package.json must be untouched by a skew failure').toBe(rawAfterEdit);
    },
    180000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — the global opt-out config reaches the sync through the real CLI
// Cheap: same shape as test 2 (--dry-run, never deploys). Uses an isolated
// AGENTCORE_CONFIG_DIR so the `agentcore config` write can't leak into the
// machine's real global config. NOTE: because this is a --dry-run, check mode
// alone would already downgrade skew to a warning — the opt-out-specific signal
// here is `outcome: 'opted-out'` / `optedOut: true` in the JSON envelope. The
// behavioral downgrade (opt-out turning a would-be CliVersionTooOldError into a
// warning on a REAL deploy) is covered by the unit test "downgrades skew to a
// warning and touches nothing when disabled" in
// src/lib/dependency-management/__tests__/sync.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential('e2e: dependency sync — global opt-out config is plumbed through to the sync', () => {
  let testDir: string;
  let projectPath: string;
  let configDir: string;
  const agentName = `E2eDepSyncOpt${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let rawAfterEdit: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-depsync-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    projectPath = await scaffoldProject(testDir, agentName);

    // Opt out of dependency management, isolated from the real ~/.agentcore.
    configDir = join(testDir, 'agentcore-global-config');
    const configResult = await spawnAndCollect(
      'agentcore',
      ['config', 'disableDependencyManagement', 'true'],
      projectPath,
      { AGENTCORE_CONFIG_DIR: configDir }
    );
    expect(configResult.exitCode, `config set failed: ${configResult.stderr}`).toBe(0);
    expect(configResult.stdout).toContain('Set disableDependencyManagement = true');

    // Same higher-minor skew as test 3.
    const { manifest } = await readCdkManifest(projectPath);
    const vendedManagedSpec = manifest.dependencies?.[MANAGED_DEP] ?? '';
    expect(vendedManagedSpec, `${MANAGED_DEP} should be a managed (vended) dependency`).toMatch(/^~/);
    await setManagedDepVersion(projectPath, MANAGED_DEP, `~${higherMinorVersionOf(vendedManagedSpec)}`);
    rawAfterEdit = (await readCdkManifest(projectPath)).raw;
  }, 300000);

  afterAll(async () => {
    // No stack was ever created — only the local project needs cleaning up.
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 30000);

  it.skipIf(!canRun)(
    'sync reports opted-out, surfaces skew as a warning, and leaves package.json unchanged',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await spawnAndCollect('agentcore', ['deploy', '--dry-run', '--yes', '--json'], projectPath, {
        AGENTCORE_CONFIG_DIR: configDir,
      });
      expect(result.exitCode, `Opted-out deploy failed (stderr: ${result.stderr}, stdout: ${result.stdout})`).toBe(0);

      const json = parseJsonOutput(result.stdout) as DeployJsonEnvelope;
      expect(json.success).toBe(true);

      const sync = json.dependencySyncResult;
      expect(sync, 'Deploy result should carry dependencySyncResult').toBeDefined();
      // The opt-out-specific signal: the config write reached the sync through the real CLI.
      // (This is a --dry-run, so check mode would surface skew as a warning even without the
      // opt-out — outcome/optedOut is what proves the opt-out plumbing.)
      expect(sync!.outcome, 'Opt-out should win over check mode in the outcome').toBe('opted-out');
      expect(sync!.optedOut, 'Global opt-out should be reflected in the sync result').toBe(true);
      // In this mode skew is surfaced as a warning, not an error.
      expect(sync!.skewWarning, 'Skew should be surfaced as a warning in this mode').toBe(true);
      const warnings = sync!.warnings.join('\n');
      expect(warnings).toContain(MANAGED_DEP);
      expect(warnings).toContain('newer than this CLI was tested with');
      expect(warnings).toContain('upgrade the CLI');

      // Opted-out sync never writes.
      const { raw } = await readCdkManifest(projectPath);
      expect(raw, 'package.json must be untouched when opted out').toBe(rawAfterEdit);
    },
    300000
  );
});
