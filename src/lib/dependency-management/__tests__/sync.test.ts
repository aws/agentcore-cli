import { CliVersionTooOldError, DependencySyncError } from '../../errors/types';
import { syncManagedDependencies } from '../index';
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
    '@aws/agentcore-cdk': '0.1.0-alpha.45',
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
  const run = (disabled = false) =>
    syncManagedDependencies({ vendedPackageJsonPath: vendedPath, projectDir, disabled });

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'dep-sync-test-'));
    projectDir = path.join(tempDir, 'agentcore', 'cdk');
    mkdirSync(projectDir, { recursive: true });
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
    expect(result.changes).toEqual([]);
    expect(result.reinstalled).toBe(false);
    expect(result.notice).toBeNull();
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('migrates caret ranges, reinstalls, and reports', async () => {
    mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(projectDir, 'package-lock.json'), '{}');
    writeProject({
      dependencies: { '@aws/agentcore-cdk': '^0.1.0-alpha.19', 'aws-cdk-lib': '^2.248.0', lodash: '^4.17.21' },
      devDependencies: { typescript: '~5.9.3' },
    });

    const result = await run();

    expect(result.migrated).toBe(true);
    expect(result.reinstalled).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.notice).toContain('created before the AgentCore CLI managed dependency versions');
    expect(result.notice).toContain('Dependencies you added yourself were not changed.');
    expect(result.notice).toContain('disableDependencyManagement');

    const written = readProject();
    expect(written.dependencies['@aws/agentcore-cdk']).toBe('0.1.0-alpha.45');
    expect(written.dependencies['aws-cdk-lib']).toBe('~2.261.0');
    expect(written.dependencies.lodash).toBe('^4.17.21');

    expect(existsSync(path.join(projectDir, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(projectDir, 'package-lock.json'))).toBe(false);
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('npm', ['install'], { cwd: projectDir });
  });

  it('preserves key order and unknown fields when rewriting', async () => {
    writeProject({
      zeta: 'kept',
      dependencies: { lodash: '1.0.0', 'aws-cdk-lib': '~2.250.0', '@aws/agentcore-cdk': '0.1.0-alpha.45' },
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

  it('downgrades skew to a warning and touches nothing when disabled', async () => {
    const manifest = {
      dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.300.0', old: '^1.0.0' },
      devDependencies: { typescript: '~5.8.0' },
    };
    writeProject(manifest);
    const result = await run(true);
    expect(result.optedOut).toBe(true);
    expect(result.skewWarning).toBe(true);
    expect(result.warnings.some(w => w.includes('newer than this CLI was tested with'))).toBe(true);
    expect(result.notice).toBeNull();
    expect(readProject()).toEqual(manifest);
    expect(mockRunSubprocessCapture).not.toHaveBeenCalled();
  });

  it('restores a deleted managed dependency', async () => {
    writeProject({
      dependencies: { '@aws/agentcore-cdk': '0.1.0-alpha.45' },
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

  it('wraps npm install failure in DependencySyncError', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ stdout: '', stderr: 'E404', code: 1, signal: null });
    writeProject({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.250.0' }, devDependencies: {} });
    await expect(run()).rejects.toThrow(DependencySyncError);
  });

  it('wraps unreadable project package.json in DependencySyncError', async () => {
    await expect(run()).rejects.toThrow(DependencySyncError);
  });
});
