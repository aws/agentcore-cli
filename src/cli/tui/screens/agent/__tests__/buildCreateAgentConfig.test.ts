import type { GenerateConfig } from '../../generate/types';
import { buildCreateAgentConfig } from '../buildCreateAgentConfig';
import { describe, expect, it } from 'vitest';

function baseConfig(overrides: Partial<GenerateConfig> = {}): GenerateConfig {
  return {
    projectName: 'demo',
    buildType: 'CodeZip',
    protocol: 'HTTP',
    sdk: 'Strands',
    modelProvider: 'Bedrock',
    memory: 'none',
    language: 'Python',
    ...overrides,
  };
}

describe('buildCreateAgentConfig', () => {
  it('maps the core template fields', () => {
    const result = buildCreateAgentConfig('myagent', baseConfig());
    expect(result).toMatchObject({
      name: 'myagent',
      agentType: 'create',
      codeLocation: 'myagent/',
      entrypoint: 'main.py',
      language: 'Python',
      buildType: 'CodeZip',
      protocol: 'HTTP',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  // Regression guard: the capacity-provider attachment was silently dropped here before — the
  // confirm screen showed it but the written agent had capacityProviderConfiguration: null.
  it('carries a by-name capacity provider attachment and volume mounts', () => {
    const result = buildCreateAgentConfig(
      'cpagent',
      baseConfig({
        networkMode: 'PUBLIC',
        capacityProviderConfiguration: { capacityProviderName: 'MyCp' },
        capacityProviderVolumes: [{ volumeName: 'model-weights', mountPath: '/mnt/models' }],
      })
    );
    expect(result.capacityProviderConfiguration).toEqual({ capacityProviderName: 'MyCp' });
    expect(result.capacityProviderVolumes).toEqual([{ volumeName: 'model-weights', mountPath: '/mnt/models' }]);
  });

  it('carries a by-ARN capacity provider attachment', () => {
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/foo-AbCdEfGhIj';
    const result = buildCreateAgentConfig(
      'cpagent',
      baseConfig({ capacityProviderConfiguration: { capacityProviderArn: arn } })
    );
    expect(result.capacityProviderConfiguration).toEqual({ capacityProviderArn: arn });
  });

  it('omits capacity-provider fields when none are attached', () => {
    const result = buildCreateAgentConfig('plain', baseConfig());
    expect(result.capacityProviderConfiguration).toBeUndefined();
    expect(result.capacityProviderVolumes).toBeUndefined();
  });

  it('drops empty capacity-provider volume arrays rather than emitting []', () => {
    const result = buildCreateAgentConfig(
      'cpagent',
      baseConfig({ capacityProviderConfiguration: { capacityProviderName: 'MyCp' }, capacityProviderVolumes: [] })
    );
    expect(result.capacityProviderVolumes).toBeUndefined();
  });

  it('only carries subnets/securityGroups when networkMode is VPC', () => {
    const publicCfg = buildCreateAgentConfig('a', baseConfig({ networkMode: 'PUBLIC', subnets: ['subnet-x'] }));
    expect(publicCfg.subnets).toBeUndefined();

    const vpcCfg = buildCreateAgentConfig(
      'a',
      baseConfig({ networkMode: 'VPC', subnets: ['subnet-x'], securityGroups: ['sg-y'] })
    );
    expect(vpcCfg.subnets).toEqual(['subnet-x']);
    expect(vpcCfg.securityGroups).toEqual(['sg-y']);
  });
});
