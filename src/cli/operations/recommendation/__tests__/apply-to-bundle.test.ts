import type { ConfigIO } from '../../../../lib';
import type { RecommendationResult } from '../../../aws/agentcore-recommendation';
import { applyRecommendationToBundle } from '../apply-to-bundle';
import assert from 'node:assert';
import { describe, expect, it, vi } from 'vitest';

const { RUNTIME_ARN, BUNDLE_ARN, NEW_VERSION_ID } = vi.hoisted(() => ({
  RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/myAgent-abc123',
  BUNDLE_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/MyBundle-xyz789',
  NEW_VERSION_ID: 'v2-recommendation',
}));

vi.mock('../../../aws/agentcore-config-bundles', () => ({
  getConfigurationBundleVersion: vi.fn().mockResolvedValue({
    bundleArn: BUNDLE_ARN,
    bundleId: 'MyBundle-xyz789',
    bundleName: 'MyBundle',
    versionId: NEW_VERSION_ID,
    components: {
      [RUNTIME_ARN]: {
        configuration: {
          systemPrompt: 'new improved prompt',
          temperature: 0.8,
        },
      },
    },
    lineageMetadata: {
      commitMessage: 'Recommendation applied',
    },
    createdAt: '2026-04-12T00:00:00Z',
    versionCreatedAt: '2026-04-12T00:00:00Z',
  }),
}));

function makeConfigIO(spec: Record<string, unknown>, deployedState?: Record<string, unknown>) {
  const writeSpecSpy = vi.fn().mockResolvedValue(undefined);
  const writeDeployedStateSpy = vi.fn().mockResolvedValue(undefined);
  const configIO = {
    readProjectSpec: vi.fn().mockResolvedValue(spec),
    writeProjectSpec: writeSpecSpy,
    readDeployedState: vi.fn().mockResolvedValue(
      deployedState ?? {
        targets: {
          default: {
            resources: {
              configBundles: {
                MyBundle: {
                  bundleId: 'MyBundle-xyz789',
                  bundleArn: BUNDLE_ARN,
                  versionId: 'v1',
                },
              },
            },
          },
        },
      }
    ),
    writeDeployedState: writeDeployedStateSpy,
  } as unknown as ConfigIO;
  return { configIO, writeSpecSpy, writeDeployedStateSpy };
}

function makeSpec(systemPrompt = 'old prompt') {
  return {
    name: 'testProject',
    configBundles: [
      {
        name: 'MyBundle',
        type: 'ConfigurationBundle',
        components: {
          [RUNTIME_ARN]: {
            configuration: {
              systemPrompt,
              temperature: 0.7,
            },
          },
        },
        branchName: 'main',
        commitMessage: 'Initial',
      },
    ],
  };
}

describe('applyRecommendationToBundle', () => {
  it('syncs local config from server-created version by bundle name', async () => {
    const spec = makeSpec();
    const { configIO, writeSpecSpy, writeDeployedStateSpy } = makeConfigIO(spec);

    const result: RecommendationResult = {
      systemPromptRecommendationResult: {
        recommendedSystemPrompt: 'new improved prompt',
        configurationBundle: { bundleArn: BUNDLE_ARN, versionId: NEW_VERSION_ID },
      },
    };

    const applyResult = await applyRecommendationToBundle(
      { bundleName: 'MyBundle', result, region: 'us-east-1' },
      configIO
    );

    assert(applyResult.success);
    expect(applyResult.newVersionId).toBe(NEW_VERSION_ID);

    // Verify spec was written with server components
    expect(writeSpecSpy).toHaveBeenCalledTimes(1);
    const writtenSpec = writeSpecSpy.mock.calls[0]![0];
    expect(writtenSpec.configBundles[0].components[RUNTIME_ARN].configuration.systemPrompt).toBe('new improved prompt');
    // Server version has temperature 0.8 (not local 0.7)
    expect(writtenSpec.configBundles[0].components[RUNTIME_ARN].configuration.temperature).toBe(0.8);
    // Commit message from lineage metadata
    expect(writtenSpec.configBundles[0].commitMessage).toBe('Recommendation applied');

    // Verify deployed state was updated with new version
    expect(writeDeployedStateSpy).toHaveBeenCalledTimes(1);
    const writtenState = writeDeployedStateSpy.mock.calls[0]![0];
    expect(writtenState.targets.default.resources.configBundles.MyBundle.versionId).toBe(NEW_VERSION_ID);
  });

  it('syncs local config by bundle ARN via deployed state', async () => {
    const spec = makeSpec();
    const { configIO } = makeConfigIO(spec);

    const result: RecommendationResult = {
      systemPromptRecommendationResult: {
        recommendedSystemPrompt: 'ARN-resolved prompt',
        configurationBundle: { bundleArn: BUNDLE_ARN, versionId: NEW_VERSION_ID },
      },
    };

    const applyResult = await applyRecommendationToBundle(
      { bundleArn: BUNDLE_ARN, result, region: 'us-east-1' },
      configIO
    );

    assert(applyResult.success);
    expect(applyResult.newVersionId).toBe(NEW_VERSION_ID);
  });

  it('syncs tool description recommendation result', async () => {
    const spec = makeSpec();
    const { configIO } = makeConfigIO(spec);

    const result: RecommendationResult = {
      toolDescriptionRecommendationResult: {
        tools: [{ toolName: 'search', recommendedToolDescription: 'new desc' }],
        configurationBundle: { bundleArn: BUNDLE_ARN, versionId: NEW_VERSION_ID },
      },
    };

    const applyResult = await applyRecommendationToBundle(
      { bundleName: 'MyBundle', result, region: 'us-east-1' },
      configIO
    );

    assert(applyResult.success);
    expect(applyResult.newVersionId).toBe(NEW_VERSION_ID);
  });

  it('returns error when result has no configurationBundle', async () => {
    const spec = makeSpec();
    const { configIO, writeSpecSpy } = makeConfigIO(spec);

    const result: RecommendationResult = {
      systemPromptRecommendationResult: {
        recommendedSystemPrompt: 'new prompt',
      },
    };

    const applyResult = await applyRecommendationToBundle(
      { bundleName: 'MyBundle', result, region: 'us-east-1' },
      configIO
    );

    assert(!applyResult.success);
    expect(applyResult.error.message).toContain('does not contain a new config bundle version');
    expect(writeSpecSpy).not.toHaveBeenCalled();
  });

  it('returns error when bundle not found in agentcore.json', async () => {
    const spec = makeSpec();
    const { configIO, writeSpecSpy } = makeConfigIO(spec);

    const result: RecommendationResult = {
      systemPromptRecommendationResult: {
        recommendedSystemPrompt: 'new',
        configurationBundle: { bundleArn: BUNDLE_ARN, versionId: NEW_VERSION_ID },
      },
    };

    const applyResult = await applyRecommendationToBundle(
      { bundleName: 'NonExistent', result, region: 'us-east-1' },
      configIO
    );

    assert(!applyResult.success);
    expect(applyResult.error.message).toContain('NonExistent');
    expect(writeSpecSpy).not.toHaveBeenCalled();
  });
});
