import type { DependencySyncResult } from '../../../../lib/dependency-management';
import type { LocalCdkProject } from '../../../cdk/local-cdk-project';
import {
  ensureManagedDependencies,
  failedSyncResult,
  teardownSyncFailureResult,
  toDepSyncAttrs,
} from '../dependency-sync';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSyncManagedDependencies } = vi.hoisted(() => ({
  mockSyncManagedDependencies: vi.fn(),
}));

vi.mock('../../../../lib/dependency-management', () => ({
  syncManagedDependencies: mockSyncManagedDependencies,
}));

vi.mock('../../../../lib/schemas/io/global-config', () => ({
  readGlobalConfigSync: () => ({}),
}));

/** Every field of the no-op base shape shared by failedSyncResult / teardownSyncFailureResult. */
function expectNoOpShape(result: DependencySyncResult): void {
  expect(result.optedOut).toBe(false);
  expect(result.checkOnly).toBe(false);
  expect(result.migratedFromCaret).toBe(false);
  expect(result.reinstalled).toBe(false);
  expect(result.skewWarning).toBe(false);
  expect(result.changes).toEqual([]);
  expect(result.restored).toEqual([]);
  expect(result.skipped).toEqual([]);
  expect(result.notice).toBeNull();
}

describe('failedSyncResult', () => {
  it('is a no-op result with outcome "failed" and no warning line (the thrown error carries the message)', () => {
    const result = failedSyncResult();
    expect(result.outcome).toBe('failed');
    expect(result.warnings).toEqual([]);
    expectNoOpShape(result);
  });
});

describe('teardownSyncFailureResult', () => {
  it('is a no-op result with outcome "failure-suppressed" and the failure surfaced as a warning', () => {
    const result = teardownSyncFailureResult(new Error('npm install failed (exit 1): E404'));
    expect(result.outcome).toBe('failure-suppressed');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Dependency sync failed (continuing with teardown)');
    expect(result.warnings[0]).toContain('npm install failed (exit 1): E404');
    expectNoOpShape(result);
  });
});

describe('ensureManagedDependencies', () => {
  const origSkipInstall = process.env.AGENTCORE_SKIP_INSTALL;

  afterEach(() => {
    vi.clearAllMocks();
    if (origSkipInstall !== undefined) process.env.AGENTCORE_SKIP_INSTALL = origSkipInstall;
    else delete process.env.AGENTCORE_SKIP_INSTALL;
  });

  it('skips the sync entirely when AGENTCORE_SKIP_INSTALL is set', async () => {
    process.env.AGENTCORE_SKIP_INSTALL = '1';

    const result = await ensureManagedDependencies({ projectDir: '/project/agentcore/cdk' } as LocalCdkProject);

    expect(result.outcome).toBe('skipped');
    expect(result.warnings).toEqual([]);
    expectNoOpShape(result);
    expect(mockSyncManagedDependencies).not.toHaveBeenCalled();
  });
});

describe('toDepSyncAttrs', () => {
  it('maps a sync result to dep_sync_* telemetry attrs, including the outcome', () => {
    const result: DependencySyncResult = {
      outcome: 'synced',
      optedOut: false,
      checkOnly: false,
      migratedFromCaret: true,
      reinstalled: true,
      skewWarning: true,
      changes: [{ name: 'aws-cdk-lib', section: 'dependencies', from: '^2.248.0', to: '~2.261.0' }],
      restored: [{ name: 'constructs', section: 'dependencies', to: '~10.4.2' }],
      skipped: [],
      warnings: ['skew warning'],
      notice: 'updated',
    };

    expect(toDepSyncAttrs(result)).toEqual({
      dep_sync_outcome: 'synced',
      dep_sync_changed_count: 2,
      dep_sync_migrated: true,
      dep_sync_opted_out: false,
      dep_sync_skew_warning: true,
      dep_sync_reinstalled: true,
    });
  });

  it('maps every no-op outcome through dep_sync_outcome', () => {
    expect(toDepSyncAttrs(failedSyncResult()).dep_sync_outcome).toBe('failed');
    expect(toDepSyncAttrs(teardownSyncFailureResult(new Error('boom'))).dep_sync_outcome).toBe('failure-suppressed');
  });
});
