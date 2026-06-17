import type { DeployedState, HarnessDeployedState } from '../../../../schema';
import { findOrphanHarnesses, isOrphanHarnessRecord, regionFromHarnessArn } from '../orphan';
import { describe, expect, it } from 'vitest';

const cfnRecord: HarnessDeployedState = {
  harnessId: 'h-cfn',
  harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-cfn',
  roleArn: 'arn:aws:iam::111122223333:role/cfn',
  status: 'READY',
  provisioner: 'cloudformation',
};

const orphanRecord: HarnessDeployedState = {
  harnessId: 'h-orphan',
  harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-orphan',
  roleArn: 'arn:aws:iam::111122223333:role/orphan',
  status: 'READY',
};

function stateWith(harnesses: Record<string, HarnessDeployedState>, targetName = 'default'): DeployedState {
  return { targets: { [targetName]: { resources: { stackName: 'S', harnesses } } } };
}

describe('isOrphanHarnessRecord', () => {
  it('treats a record without the cloudformation marker as an orphan', () => {
    expect(isOrphanHarnessRecord(orphanRecord)).toBe(true);
  });

  it('treats a cloudformation-marked record as not an orphan', () => {
    expect(isOrphanHarnessRecord(cfnRecord)).toBe(false);
  });

  it('treats an absent record as not an orphan', () => {
    expect(isOrphanHarnessRecord(undefined)).toBe(false);
  });
});

describe('regionFromHarnessArn', () => {
  it('parses the region segment', () => {
    expect(regionFromHarnessArn('arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h')).toBe('us-west-2');
  });

  it('returns undefined for a malformed ARN with no region', () => {
    expect(regionFromHarnessArn('arn:aws:bedrock-agentcore::111122223333:harness/h')).toBeUndefined();
    expect(regionFromHarnessArn('not-an-arn')).toBeUndefined();
  });
});

describe('findOrphanHarnesses', () => {
  it('returns only unmarked records, with id/arn/region populated', () => {
    const state = stateWith({ keep: cfnRecord, old: orphanRecord });
    const orphans = findOrphanHarnesses(state);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      name: 'old',
      targetName: 'default',
      harnessId: 'h-orphan',
      region: 'us-west-2',
    });
  });

  it('filters to a specific harness name when provided', () => {
    const state = stateWith({ old: orphanRecord, alsoOld: { ...orphanRecord, harnessId: 'h2' } });
    expect(findOrphanHarnesses(state, 'old')).toHaveLength(1);
    expect(findOrphanHarnesses(state, 'old')[0]!.name).toBe('old');
  });

  it('returns nothing when every record carries the cloudformation marker', () => {
    expect(findOrphanHarnesses(stateWith({ keep: cfnRecord }))).toEqual([]);
  });

  it('skips orphan records whose ARN has no parseable region (cannot be safely deleted)', () => {
    const bad: HarnessDeployedState = { ...orphanRecord, harnessArn: 'not-an-arn' };
    expect(findOrphanHarnesses(stateWith({ bad }))).toEqual([]);
  });

  it('finds orphans across multiple targets', () => {
    const state: DeployedState = {
      targets: {
        default: { resources: { stackName: 'S1', harnesses: { a: orphanRecord } } },
        prod: { resources: { stackName: 'S2', harnesses: { b: { ...orphanRecord, harnessId: 'h-b' } } } },
      },
    };
    const orphans = findOrphanHarnesses(state);
    expect(orphans.map(o => o.targetName).sort()).toEqual(['default', 'prod']);
  });

  it('handles missing/empty deployed state', () => {
    expect(findOrphanHarnesses(undefined)).toEqual([]);
    expect(findOrphanHarnesses({ targets: {} })).toEqual([]);
  });
});
