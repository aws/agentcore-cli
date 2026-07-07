import type { DeployedState } from '../../../../../schema';
import { resolveBundleVersionId } from '../build-config';
import { describe, expect, it } from 'vitest';

const BUNDLE_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/Proj-PromptV1-abc123';
const VERSION_ID = 'a7be96aa-8a83-47b8-8d98-0829b14c1d9b';

const deployedState = {
  targets: {
    default: {
      resources: {
        configBundles: {
          PromptV1: { bundleArn: BUNDLE_ARN, versionId: VERSION_ID },
        },
      },
    },
  },
} as unknown as DeployedState;

describe('resolveBundleVersionId', () => {
  it("expands 'LATEST' to the deployed versionId", () => {
    expect(resolveBundleVersionId(BUNDLE_ARN, 'LATEST', deployedState)).toBe(VERSION_ID);
  });

  it('returns an explicit version verbatim (never touches deployed state)', () => {
    const explicit = '11111111-2222-3333-4444-555555555555';
    expect(resolveBundleVersionId(BUNDLE_ARN, explicit, deployedState)).toBe(explicit);
  });

  it("returns undefined when 'LATEST' cannot be resolved (bundle not deployed)", () => {
    const unknownArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/Proj-Unknown-zzz999';
    expect(resolveBundleVersionId(unknownArn, 'LATEST', deployedState)).toBeUndefined();
  });

  it('returns undefined for LATEST when there are no deployed targets', () => {
    expect(resolveBundleVersionId(BUNDLE_ARN, 'LATEST', { targets: {} } as unknown as DeployedState)).toBeUndefined();
  });
});
