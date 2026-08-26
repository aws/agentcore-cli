import { CliVersionTooOldError, DependencySyncError } from '../../errors/types';
import { syncManagedDependencies } from '../sync';
import type { SyncManagedDependenciesOptions } from '../types';
import { CDK_PIN } from './fixtures';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunSubprocessCapture = vi.hoisted(() => vi.fn());
vi.mock('../../utils/subprocess', () => ({
  runSubprocessCapture: mockRunSubprocessCapture,
}));

const VENDED = {
  name: 'agentcore-cdk-app',
  dependencies: {
    '@aws/agentcore-cdk': CDK_PIN,
    'aws-cdk-lib': '~2.261.0',
  },
  devDependencies: {
    typescript: '~5.9.3',
  },
};

describe('syncManagedDependencies', () => {
  let tempDir: string;
  let projectDir: string;
  let vendedPath: string;

  const writeProject = (manifest: object) => {
    writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  };
  const readProject = () => JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
  const run = (options: Partial<SyncManagedDependenciesOptions> = {}) =>
    syncManagedDependencies({ vendedPackageJsonPath: vendedPath, projectDir, ...options });

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'dep-sync-test-'));
    projectDir = path.join(tempDir, 'agentcore', 'cdk');
    mkdirSync(projectDir, { recursive: true });
    // Most tests exercise the manifest-diff path, not install self-healing — pre-create
    // node_modules so a missing tree doesn't trigger the recovery install.
    mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true });
    vendedPath = path.join(tempDir, 'vended-package.json');
    writeFileSync(vendedPath, JSON.stringify(VENDED, null, 2));
    mockRunSubprocessCapture.mockResolvedValue({ stdout: '', stderr: '', code: 0, signal: null });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('is a no-op when the project already matches (no write, no reinstall, no notice)', async () => {
    writeProject({ dependencies: { ...VENDED.dependencies }, devDependencies: { ...VENDED.devDependencies } });
    const result = await run();
    expect(result.outcome).toBe('synced');
    expect(result.changes).toEqual([]);
    expect(result.reinstalled).toBe(false);
    expect(result.notice).toBeNull();
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('migrates caret ranges, reinstalls incrementally, and reports', async () => {
    writeFileSync(path.join(projectDir, 'package-lock.json'), '{}');
    writeProject({
      dependencies: { '@aws/agentcore-cdk': '^0.1.0-alpha.19', 'aws-cdk-lib': '^2.248.0', lodash: '^4.17.21' },
      devDependencies: { typescript: '~5.9.3' },
    });

    const result = await run();

    expect(result.migratedFromCaret).toBe(true);
    expect(result.reinstalled).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.notice).toContain('created before the AgentCore CLI managed dependency versions');
    expect(result.notice).toContain('Dependencies you added yourself were not changed.');
    expect(result.notice).toContain('disableDependencyManagement');

    const written = readProject();
    expect(written.dependencies['@aws/agentcore-cdk']).toBe(CDK_PIN);
    expect(written.dependencies['aws-cdk-lib']).toBe('~2.261.0');
    expect(written.dependencies.lodash).toBe('^4.17.21');

    // The install is incremental: node_modules and the lockfile are never deleted, so
    // user-added deps keep their resolved versions and installs stay warm.
    expect(existsSync(path.join(projectDir, 'node_modules'))).toBe(true);
    expect(existsSync(path.join(projectDir, 'package-lock.json'))).toBe(true);
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('npm', ['install'], { cwd: projectDir });
  });

  it('installs when node_modules is missing even if the manifest already matches (self-healing)', async () => {
    rmSync(path.join(projectDir, 'node_modules'), { recursive: true, force: true });
    writeProject({ dependencies: { ...VENDED.dependencies }, devDependencies: { ...VENDED.devDependencies } });

    const result = await run();

    expect(result.changes).toEqual([]);
    expect(result.reinstalled).toBe(true);
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('npm', ['install'], { cwd: projectDir });
  });

  it('preserves key order and unknown fields when rewriting', async () => {
    writeProject({
      zeta: 'kept',
      dependencies: { lodash: '1.0.0', 'aws-cdk-lib': '~2.250.0', '@aws/agentcore-cdk': CDK_PIN },
      scripts: { build: 'tsc' },
      devDependencies: { typescript: '~5.9.3' },
    });
    await run();
    const raw = readFileSync(path.join(projectDir, 'package.json'), 'utf-8');
    const written = JSON.parse(raw);
    expect(Object.keys(written)).toEqual(['zeta', 'dependencies', 'scripts', 'devDependencies']);
    expect(Object.keys(written.dependencies)).toEqual(['lodash', 'aws-cdk-lib', '@aws/agentcore-cdk']);
    expect(written.zeta).toBe('kept');
  });

  it('throws CliVersionTooOldError when the project declares a higher minor', async () => {
    writeProject({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0' }, devDependencies: {} });
    await expect(run()).rejects.toThrow(CliVersionTooOldError);
    await expect(run()).rejects.toThrow(/newer version of the AgentCore CLI/);
  });

  it('names the skewed dep, uses the provided install command, and mentions the opt-out in the skew error', async () => {
    writeProject({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0' }, devDependencies: {} });
    const err = await run({ installCommand: 'npm install -g @aws/agentcore@preview' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliVersionTooOldError);
    const message = (err as Error).message;
    expect(message).toContain('aws-cdk-lib');
    expect(message).toContain('~2.300.0');
    expect(message).toContain('npm install -g @aws/agentcore@preview');
    expect(message).toContain('disableDependencyManagement');
  });

  it('defaults the install command to the public package name', async () => {
    writeProject({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0' }, devDependencies: {} });
    await expect(run()).rejects.toThrow(/npm install -g @aws\/agentcore@latest/);
  });

  it('downgrades skew to a warning and touches nothing when disabled', async () => {
    const manifest = {
      dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0', old: '^1.0.0' },
      devDependencies: { typescript: '~5.8.0' },
    };
    writeProject(manifest);
    const result = await run({ disabled: true });
    expect(result.outcome).toBe('opted-out');
    expect(result.optedOut).toBe(true);
    expect(result.skewWarning).toBe(true);
    expect(result.warnings.some(w => w.includes('newer than this CLI was tested with'))).toBe(true);
    expect(result.notice).toBeNull();
    expect(readProject()).toEqual(manifest);
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('downgrades skew to a warning but still syncs when treatSkewAsWarning is set', async () => {
    writeProject({
      dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0', '@aws/agentcore-cdk': '^0.1.0-alpha.19' },
      devDependencies: { typescript: '~5.9.3' },
    });
    const result = await run({ treatSkewAsWarning: true });
    expect(result.skewWarning).toBe(true);
    expect(result.warnings.some(w => w.includes('newer than this CLI was tested with'))).toBe(true);
    // The skewed dep is left alone; the other managed dep still syncs.
    expect(readProject().dependencies['aws-cdk-lib']).toBe('~2.300.0');
    expect(readProject().dependencies['@aws/agentcore-cdk']).toBe(CDK_PIN);
  });

  it('check mode computes the plan and a future-tense notice without writing or installing', async () => {
    const manifest = {
      dependencies: { '@aws/agentcore-cdk': '^0.1.0-alpha.19', 'aws-cdk-lib': '^2.248.0' },
      devDependencies: { typescript: '~5.9.3' },
    };
    writeProject(manifest);
    const result = await run({ mode: 'check' });
    expect(result.outcome).toBe('check-only');
    expect(result.checkOnly).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.reinstalled).toBe(false);
    expect(result.notice).toContain('will be updated on the next deploy');
    expect(result.notice).not.toContain("We've updated");
    expect(readProject()).toEqual(manifest);
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('disabled wins over check mode in the outcome (opted-out, with checkOnly preserved)', async () => {
    const manifest = {
      dependencies: { '@aws/agentcore-cdk': '^0.1.0-alpha.19', 'aws-cdk-lib': '~2.261.0' },
      devDependencies: { typescript: '~5.9.3' },
    };
    writeProject(manifest);
    const result = await run({ disabled: true, mode: 'check' });
    expect(result.outcome).toBe('opted-out');
    expect(result.optedOut).toBe(true);
    // The overlapping detail survives: the run was also check-only.
    expect(result.checkOnly).toBe(true);
    expect(result.notice).toBeNull();
    expect(readProject()).toEqual(manifest);
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('check mode reports skew as a warning instead of throwing', async () => {
    const manifest = { dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0' }, devDependencies: {} };
    writeProject(manifest);
    const result = await run({ mode: 'check' });
    expect(result.skewWarning).toBe(true);
    expect(result.warnings.some(w => w.includes('newer than this CLI was tested with'))).toBe(true);
    expect(readProject()).toEqual(manifest);
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('restores a deleted managed dependency', async () => {
    writeProject({
      dependencies: { '@aws/agentcore-cdk': CDK_PIN },
      devDependencies: { typescript: '~5.9.3' },
    });
    const result = await run();
    expect(result.restored).toEqual([{ name: 'aws-cdk-lib', section: 'dependencies', to: '~2.261.0' }]);
    expect(readProject().dependencies['aws-cdk-lib']).toBe('~2.261.0');
    expect(result.notice).toContain('aws-cdk-lib');
  });

  it('skips a file: override with a warning and no rewrite', async () => {
    writeProject({
      dependencies: { ...VENDED.dependencies, '@aws/agentcore-cdk': 'file:bundled-agentcore-cdk.tgz' },
      devDependencies: { ...VENDED.devDependencies },
    });
    const result = await run();
    expect(result.skipped).toHaveLength(1);
    expect(result.warnings[0]).toContain('file:bundled-agentcore-cdk.tgz');
    expect(readProject().dependencies['@aws/agentcore-cdk']).toBe('file:bundled-agentcore-cdk.tgz');
  });

  it('wraps npm install failure in DependencySyncError and restores the original manifest', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ stdout: '', stderr: 'E404', code: 1, signal: null });
    const original = { dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.250.0' }, devDependencies: {} };
    writeProject(original);
    await expect(run()).rejects.toThrow(DependencySyncError);
    // The rewrite is rolled back on install failure. Otherwise a retry would see a manifest that
    // already matches the pins plus a still-present node_modules, skip the install, and deploy
    // against the stale installed tree — the exact skew this sync exists to prevent.
    expect(readProject()).toEqual(original);
  });

  it('recomputes the same plan and re-attempts the install on retry after an install failure', async () => {
    mockRunSubprocessCapture.mockResolvedValueOnce({ stdout: '', stderr: 'E404', code: 1, signal: null });
    writeProject({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.250.0' }, devDependencies: {} });
    await expect(run()).rejects.toThrow(DependencySyncError);

    // Second run: the restored manifest yields the same plan, and this time npm succeeds.
    const result = await run();
    expect(result.changes).toEqual([
      { name: 'aws-cdk-lib', section: 'dependencies', from: '~2.250.0', to: '~2.261.0' },
    ]);
    expect(result.reinstalled).toBe(true);
    expect(readProject().dependencies['aws-cdk-lib']).toBe('~2.261.0');
    expect(mockRunSubprocessCapture).toHaveBeenCalledTimes(2);
  });

  it('wraps unreadable project package.json in DependencySyncError', async () => {
    await expect(run()).rejects.toThrow(DependencySyncError);
  });
});
