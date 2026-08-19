import { parseCapacityProviderOutputs } from '../outputs';
import { describe, expect, it } from 'vitest';

describe('parseCapacityProviderOutputs', () => {
  it('parses Id and Arn from stack outputs', () => {
    const outputs = {
      ApplicationCapacityProviderMyCpIdOutputABC123: 'MyCp-abc1234567',
      ApplicationCapacityProviderMyCpArnOutputDEF456:
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/MyCp-abc1234567',
    };

    const result = parseCapacityProviderOutputs(outputs, ['MyCp']);

    expect(result).toEqual({
      MyCp: {
        capacityProviderId: 'MyCp-abc1234567',
        capacityProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/MyCp-abc1234567',
      },
    });
  });

  it('parses multiple capacity providers', () => {
    const outputs = {
      ApplicationCapacityProviderFirstIdOutputAAA: 'first-id',
      ApplicationCapacityProviderFirstArnOutputBBB: 'arn:first',
      ApplicationCapacityProviderSecondIdOutputCCC: 'second-id',
      ApplicationCapacityProviderSecondArnOutputDDD: 'arn:second',
    };

    const result = parseCapacityProviderOutputs(outputs, ['First', 'Second']);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.First!.capacityProviderId).toBe('first-id');
    expect(result.Second!.capacityProviderArn).toBe('arn:second');
  });

  it('skips a capacity provider when the Id output is missing', () => {
    const outputs = {
      ApplicationCapacityProviderMyCpArnOutputDEF: 'arn:test',
    };

    const result = parseCapacityProviderOutputs(outputs, ['MyCp']);

    expect(result).toEqual({});
  });

  it('returns empty for no names', () => {
    const result = parseCapacityProviderOutputs({ ApplicationCapacityProviderMyCpIdOutputX: 'x' }, []);
    expect(result).toEqual({});
  });
});
