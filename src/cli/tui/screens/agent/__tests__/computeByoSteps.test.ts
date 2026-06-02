import type { AdvancedSettingId } from '../../generate/types';
import { computeByoSteps } from '../AddAgentScreen';
import type { ComputeByoStepsInput } from '../AddAgentScreen';
import { describe, expect, it } from 'vitest';

function makeInput(overrides: Partial<ComputeByoStepsInput> = {}): ComputeByoStepsInput {
  return {
    modelProvider: 'Bedrock',
    buildType: 'CodeZip',
    networkMode: 'PUBLIC',
    authorizerType: 'AWS_IAM',
    advancedSettings: new Set<AdvancedSettingId>(),
    ...overrides,
  };
}

describe('computeByoSteps - dockerfile', () => {
  it('Container build with dockerfile selected includes dockerfile step', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    expect(steps).toContain('dockerfile');
    const advIdx = steps.indexOf('advanced');
    expect(steps[advIdx + 1]).toBe('dockerfile');
  });

  it('CodeZip build with dockerfile selected does NOT include dockerfile step', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'CodeZip',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    expect(steps).not.toContain('dockerfile');
  });

  it('dockerfile-only selection on Container has steps: advanced, dockerfile, confirm', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'confirm']);
  });

  it('dockerfile + lifecycle on Container includes both groups', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile', 'lifecycle']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'idleTimeout', 'maxLifetime', 'confirm']);
    expect(steps).not.toContain('networkMode');
  });
});

describe('computeByoSteps - filesystem', () => {
  it('filesystem without VPC: includes all filesystem steps (EFS/S3 shown with VPC warning)', () => {
    const steps = computeByoSteps(
      makeInput({
        networkMode: 'PUBLIC',
        advancedSettings: new Set<AdvancedSettingId>(['filesystem']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual([
      'advanced',
      'sessionStorageMountPath',
      'efsArn',
      'efsMountPath',
      'efsAddAnother',
      's3Arn',
      's3MountPath',
      's3AddAnother',
      'confirm',
    ]);
  });

  it('filesystem with VPC: includes sessionStorageMountPath + EFS + S3 steps', () => {
    const steps = computeByoSteps(
      makeInput({
        networkMode: 'VPC',
        advancedSettings: new Set<AdvancedSettingId>(['network', 'filesystem']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual([
      'advanced',
      'networkMode',
      'subnets',
      'securityGroups',
      'sessionStorageMountPath',
      'efsArn',
      'efsMountPath',
      'efsAddAnother',
      's3Arn',
      's3MountPath',
      's3AddAnother',
      'confirm',
    ]);
  });

  it('filesystem selected but VPC not selected: EFS/S3 steps still present', () => {
    const steps = computeByoSteps(
      makeInput({
        networkMode: 'PUBLIC',
        advancedSettings: new Set<AdvancedSettingId>(['network', 'filesystem']),
      })
    );
    expect(steps).toContain('sessionStorageMountPath');
    expect(steps).toContain('efsArn');
    expect(steps).toContain('efsAddAnother');
    expect(steps).toContain('s3Arn');
    expect(steps).toContain('s3AddAnother');
  });
});
