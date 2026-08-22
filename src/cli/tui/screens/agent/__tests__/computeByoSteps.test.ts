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

describe('computeByoSteps - vpcId (Container + VPC)', () => {
  it('Container + VPC includes vpcId immediately after securityGroups', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        networkMode: 'VPC',
        advancedSettings: new Set<AdvancedSettingId>(['network']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'networkMode', 'subnets', 'securityGroups', 'vpcId', 'confirm']);
  });

  it('CodeZip + VPC does NOT include vpcId', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'CodeZip',
        networkMode: 'VPC',
        advancedSettings: new Set<AdvancedSettingId>(['network']),
      })
    );
    expect(steps).toContain('subnets');
    expect(steps).toContain('securityGroups');
    expect(steps).not.toContain('vpcId');
  });

  it('Container + PUBLIC does NOT include vpcId (or subnets/securityGroups)', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        networkMode: 'PUBLIC',
        advancedSettings: new Set<AdvancedSettingId>(['network']),
      })
    );
    expect(steps).not.toContain('vpcId');
    expect(steps).not.toContain('subnets');
    expect(steps).not.toContain('securityGroups');
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

describe('computeByoSteps - capacity provider (J2/J3)', () => {
  it('includes the capacityProvider step when the advanced setting is selected', () => {
    const steps = computeByoSteps(makeInput({ advancedSettings: new Set<AdvancedSettingId>(['capacityProvider']) }));
    expect(steps).toContain('capacityProvider');
    // No mode selected yet → no ARN entry, no volume step.
    expect(steps).not.toContain('capacityProviderArn');
    expect(steps).not.toContain('cpVolumeMounts');
  });

  it('adds the ARN entry step and cp-volume step when attaching by ARN', () => {
    const steps = computeByoSteps(
      makeInput({ advancedSettings: new Set<AdvancedSettingId>(['capacityProvider']), capacityProviderMode: 'arn' })
    );
    const cpIdx = steps.indexOf('capacityProvider');
    expect(steps.slice(cpIdx, cpIdx + 3)).toEqual(['capacityProvider', 'capacityProviderArn', 'cpVolumeMounts']);
  });

  it('adds the cp-volume step (no ARN entry) when attaching by sibling name', () => {
    const steps = computeByoSteps(
      makeInput({ advancedSettings: new Set<AdvancedSettingId>(['capacityProvider']), capacityProviderMode: 'name' })
    );
    expect(steps).not.toContain('capacityProviderArn');
    const cpIdx = steps.indexOf('capacityProvider');
    expect(steps[cpIdx + 1]).toBe('cpVolumeMounts');
  });

  it('omits capacity provider steps entirely when the setting is not selected', () => {
    const steps = computeByoSteps(makeInput());
    expect(steps).not.toContain('capacityProvider');
    expect(steps).not.toContain('cpVolumeMounts');
  });

  it('skips the network steps when both network and capacityProvider are selected (CP wins)', () => {
    // A CP supplies its own network topology, so the two are mutually exclusive — when both are
    // picked in advanced settings the network steps are dropped in favor of the capacity provider.
    const steps = computeByoSteps(
      makeInput({
        networkMode: 'VPC',
        advancedSettings: new Set<AdvancedSettingId>(['network', 'capacityProvider']),
      })
    );
    expect(steps).not.toContain('networkMode');
    expect(steps).not.toContain('subnets');
    expect(steps).not.toContain('securityGroups');
    expect(steps).toContain('capacityProvider');
  });
});
