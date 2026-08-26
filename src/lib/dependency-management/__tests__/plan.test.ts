import { computeSyncPlan } from '../plan';
import type { PackageManifest } from '../types';
import { CDK_PIN, newerPrerelease } from './fixtures';
import { describe, expect, it } from 'vitest';

const CDK_PIN_NEWER = newerPrerelease(CDK_PIN);

const VENDED: PackageManifest = {
  dependencies: {
    '@aws/agentcore-cdk': CDK_PIN,
    'aws-cdk-lib': '~2.261.0',
    constructs: '~10.7.0',
  },
  devDependencies: {
    'aws-cdk': '~2.1126.0',
    typescript: '~5.9.3',
  },
};

function project(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    dependencies: { ...VENDED.dependencies },
    devDependencies: { ...VENDED.devDependencies },
    ...overrides,
  };
}

describe('computeSyncPlan', () => {
  it('produces an empty plan when the project already matches', () => {
    const plan = computeSyncPlan(VENDED, project());
    expect(plan).toEqual({ skew: [], changes: [], restored: [], skipped: [], migratedFromCaret: false });
  });

  it('migrates caret ranges to the vended pin and flags the migration', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({
        dependencies: {
          '@aws/agentcore-cdk': '^0.1.0-alpha.19',
          'aws-cdk-lib': '^2.248.0',
          constructs: '^10.0.0',
        },
      })
    );
    expect(plan.migratedFromCaret).toBe(true);
    expect(plan.skew).toEqual([]);
    expect(plan.changes).toEqual([
      { name: '@aws/agentcore-cdk', section: 'dependencies', from: '^0.1.0-alpha.19', to: CDK_PIN },
      { name: 'aws-cdk-lib', section: 'dependencies', from: '^2.248.0', to: '~2.261.0' },
      { name: 'constructs', section: 'dependencies', from: '^10.0.0', to: '~10.7.0' },
    ]);
  });

  it('syncs older tilde ranges without flagging migration', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.250.0' } })
    );
    expect(plan.migratedFromCaret).toBe(false);
    expect(plan.changes).toEqual([{ name: 'aws-cdk-lib', section: 'dependencies', from: '~2.250.0', to: '~2.261.0' }]);
  });

  it('flags skew when the project declares a higher minor', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.290.0' } })
    );
    expect(plan.skew).toEqual([{ name: 'aws-cdk-lib', declared: '~2.290.0', expected: '~2.261.0' }]);
    expect(plan.changes).toEqual([]);
  });

  it('flags skew when the project declares a higher major', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~3.0.0' } })
    );
    expect(plan.skew).toHaveLength(1);
  });

  it('treats a higher patch as syncable, not skew', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, 'aws-cdk-lib': '~2.261.5' } })
    );
    expect(plan.skew).toEqual([]);
    expect(plan.changes).toEqual([{ name: 'aws-cdk-lib', section: 'dependencies', from: '~2.261.5', to: '~2.261.0' }]);
  });

  it('detects prerelease skew on the exact-pinned construct (a newer prerelease than the pin)', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, '@aws/agentcore-cdk': CDK_PIN_NEWER } })
    );
    expect(plan.skew).toEqual([{ name: '@aws/agentcore-cdk', declared: CDK_PIN_NEWER, expected: CDK_PIN }]);
  });

  it('upgrades an older exact-pinned prerelease', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, '@aws/agentcore-cdk': '0.1.0-alpha.19' } })
    );
    expect(plan.skew).toEqual([]);
    expect(plan.changes).toEqual([
      { name: '@aws/agentcore-cdk', section: 'dependencies', from: '0.1.0-alpha.19', to: CDK_PIN },
    ]);
  });

  it('syncs v-prefixed specifiers instead of skipping them as non-semver', () => {
    const plan = computeSyncPlan(VENDED, project({ dependencies: { ...VENDED.dependencies, constructs: 'v10.7.0' } }));
    expect(plan.skipped).toEqual([]);
    expect(plan.skew).toEqual([]);
    expect(plan.changes).toEqual([{ name: 'constructs', section: 'dependencies', from: 'v10.7.0', to: '~10.7.0' }]);
  });

  it('never touches user-added dependencies', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({ dependencies: { ...VENDED.dependencies, lodash: '^4.17.21', 'left-pad': '*' } })
    );
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('restores a deleted managed dependency', () => {
    const proj = project();
    delete proj.dependencies!.constructs;
    const plan = computeSyncPlan(VENDED, proj);
    expect(plan.restored).toEqual([{ name: 'constructs', section: 'dependencies', to: '~10.7.0' }]);
  });

  it('skips managed deps with non-semver specifiers (bundled tarball override)', () => {
    const plan = computeSyncPlan(
      VENDED,
      project({
        dependencies: { ...VENDED.dependencies, '@aws/agentcore-cdk': 'file:bundled-agentcore-cdk.tgz' },
      })
    );
    expect(plan.changes).toEqual([]);
    expect(plan.skew).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        name: '@aws/agentcore-cdk',
        raw: 'file:bundled-agentcore-cdk.tgz',
        reason: 'uses a non-semver specifier and was left unmanaged',
      },
    ]);
  });

  it('manages devDependencies and respects the section the user has the dep in', () => {
    const proj = project({
      dependencies: { ...VENDED.dependencies, 'aws-cdk': '~2.1000.0' },
      devDependencies: { typescript: '~5.8.0' },
    });
    delete proj.devDependencies!['aws-cdk'];
    const plan = computeSyncPlan(VENDED, proj);
    expect(plan.changes).toContainEqual({
      name: 'aws-cdk',
      section: 'dependencies',
      from: '~2.1000.0',
      to: '~2.1126.0',
    });
    expect(plan.changes).toContainEqual({
      name: 'typescript',
      section: 'devDependencies',
      from: '~5.8.0',
      to: '~5.9.3',
    });
  });
});
