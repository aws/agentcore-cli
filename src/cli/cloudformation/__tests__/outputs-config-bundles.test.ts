import { parseConfigBundleOutputs } from '../outputs';
import { describe, expect, it } from 'vitest';

describe('parseConfigBundleOutputs', () => {
  it('parses BundleId, BundleArn, and VersionId from stack outputs', () => {
    const outputs = {
      ApplicationConfigBundleMyBundleIdOutputABC123: 'myBundle-abc123def',
      ApplicationConfigBundleMyBundleArnOutputDEF456:
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:configuration-bundle/myBundle-abc123def',
      ApplicationConfigBundleMyBundleVersionIdOutput789: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    };

    const result = parseConfigBundleOutputs(outputs, ['MyBundle']);

    expect(result).toEqual({
      MyBundle: {
        bundleId: 'myBundle-abc123def',
        bundleArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:configuration-bundle/myBundle-abc123def',
        versionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    });
  });

  it('parses multiple config bundles', () => {
    const outputs = {
      ApplicationConfigBundleFirstIdOutputAAA: 'first-id',
      ApplicationConfigBundleFirstArnOutputBBB: 'arn:first',
      ApplicationConfigBundleFirstVersionIdOutputCCC: 'version-1',
      ApplicationConfigBundleSecondIdOutputDDD: 'second-id',
      ApplicationConfigBundleSecondArnOutputEEE: 'arn:second',
      ApplicationConfigBundleSecondVersionIdOutputFFF: 'version-2',
    };

    const result = parseConfigBundleOutputs(outputs, ['First', 'Second']);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.First!.bundleId).toBe('first-id');
    expect(result.Second!.bundleId).toBe('second-id');
  });

  it('skips bundle when Id output is missing', () => {
    const outputs = {
      ApplicationConfigBundleMyBundleArnOutputDEF: 'arn:test',
      ApplicationConfigBundleMyBundleVersionIdOutput123: 'v1',
    };

    const result = parseConfigBundleOutputs(outputs, ['MyBundle']);

    expect(result).toEqual({});
  });

  it('skips bundle when VersionId output is missing', () => {
    const outputs = {
      ApplicationConfigBundleMyBundleIdOutputABC: 'id-123',
      ApplicationConfigBundleMyBundleArnOutputDEF: 'arn:test',
    };

    const result = parseConfigBundleOutputs(outputs, ['MyBundle']);

    expect(result).toEqual({});
  });

  it('returns empty record when no matching outputs exist', () => {
    const outputs = {
      ApplicationAgentMyAgentRuntimeIdOutputXYZ: 'rt-123',
    };

    const result = parseConfigBundleOutputs(outputs, ['MyBundle']);

    expect(result).toEqual({});
  });

  it('returns empty record for empty bundle names list', () => {
    const outputs = {
      ApplicationConfigBundleMyBundleIdOutputABC: 'id-123',
    };

    const result = parseConfigBundleOutputs(outputs, []);

    expect(result).toEqual({});
  });
});
