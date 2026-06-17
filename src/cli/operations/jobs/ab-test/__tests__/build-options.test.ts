import type { DeployedResourceState } from '../../../../../schema';
import type { StartABTestJobOptions } from '../../shared/types';
import { buildABTestRequest } from '../build-options';
import { describe, expect, it } from 'vitest';

const deployed: DeployedResourceState = {
  configBundles: {
    promptA: { bundleId: 'b-a', bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:config-bundle/a', versionId: 'v7' },
    promptB: { bundleId: 'b-b', bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:config-bundle/b', versionId: 'v3' },
  },
  onlineEvalConfigs: {
    quality: {
      onlineEvaluationConfigId: 'oe-1',
      onlineEvaluationConfigArn: 'arn:aws:bedrock-agentcore:us-east-1:1:online-evaluation-config/q',
    },
  },
};

function baseOpts(overrides: Partial<StartABTestJobOptions>): StartABTestJobOptions {
  return {
    name: 't',
    mode: 'config-bundle',
    gateway: 'gw',
    controlWeight: 50,
    treatmentWeight: 50,
    ...overrides,
  };
}

describe('buildABTestRequest', () => {
  describe('config-bundle mode', () => {
    it('resolves bundle names to ARNs and LATEST to the deployed versionId', () => {
      const built = buildABTestRequest(
        baseOpts({
          controlBundle: 'promptA',
          controlVersion: 'LATEST',
          treatmentBundle: 'promptB',
          treatmentVersion: 'v9',
          onlineEval: 'quality',
        }),
        deployed
      );

      expect(built.variants).toHaveLength(2);
      expect(built.variants[0]).toMatchObject({
        name: 'C',
        weight: 50,
        variantConfiguration: {
          configurationBundle: { bundleArn: deployed.configBundles!.promptA!.bundleArn, bundleVersion: 'v7' },
        },
      });
      expect(built.variants[1]!.variantConfiguration.configurationBundle).toEqual({
        bundleArn: deployed.configBundles!.promptB!.bundleArn,
        bundleVersion: 'v9', // explicit version is not expanded
      });
      expect(built.evaluationConfig).toEqual({
        onlineEvaluationConfigArn: deployed.onlineEvalConfigs!.quality!.onlineEvaluationConfigArn,
      });
      expect(built.variantSummaries[0]).toMatchObject({ name: 'C', bundleVersion: 'v7' });
    });

    it('throws when a required bundle field is missing', () => {
      expect(() =>
        buildABTestRequest(baseOpts({ controlBundle: 'promptA', onlineEval: 'quality' }), deployed)
      ).toThrow();
    });

    it('throws when the online-eval config is missing', () => {
      expect(() =>
        buildABTestRequest(
          baseOpts({
            controlBundle: 'promptA',
            controlVersion: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            treatmentBundle: 'promptB',
            treatmentVersion: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
          }),
          deployed
        )
      ).toThrow();
    });
  });

  describe('target-based mode', () => {
    it('uses target names as-is and builds per-variant eval config', () => {
      const built = buildABTestRequest(
        baseOpts({
          mode: 'target-based',
          controlTarget: 'ctrl',
          treatmentTarget: 'treat',
          controlOnlineEval: 'quality',
          treatmentOnlineEval: 'quality',
        }),
        deployed
      );
      expect(built.variants[0]!.variantConfiguration.target).toEqual({ name: 'ctrl' });
      expect(built.variants[1]!.variantConfiguration.target).toEqual({ name: 'treat' });
    });

    it('builds per-variant eval config from control + treatment evals', () => {
      const built = buildABTestRequest(
        baseOpts({
          mode: 'target-based',
          controlTarget: 'ctrl',
          treatmentTarget: 'treat',
          controlOnlineEval: 'quality',
          treatmentOnlineEval: 'quality',
        }),
        deployed
      );
      expect(built.evaluationConfig).toHaveProperty('perVariantOnlineEvaluationConfig');
      const perVariant = (built.evaluationConfig as { perVariantOnlineEvaluationConfig: unknown[] })
        .perVariantOnlineEvaluationConfig;
      expect(perVariant).toHaveLength(2);
    });

    it('throws when control online eval is missing', () => {
      expect(() =>
        buildABTestRequest(
          baseOpts({
            mode: 'target-based',
            controlTarget: 'ctrl',
            treatmentTarget: 'treat',
            treatmentOnlineEval: 'quality',
          }),
          deployed
        )
      ).toThrow(/control-online-eval/);
    });

    it('throws when both evals are missing', () => {
      expect(() =>
        buildABTestRequest(
          baseOpts({ mode: 'target-based', controlTarget: 'ctrl', treatmentTarget: 'treat' }),
          deployed
        )
      ).toThrow(/control-online-eval/);
    });
  });

  describe('gateway filter', () => {
    const configBundleOpts = (gatewayFilter?: string) =>
      baseOpts({
        controlBundle: 'promptA',
        controlVersion: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        treatmentBundle: 'promptB',
        treatmentVersion: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
        onlineEval: 'quality',
        gatewayFilter,
      });

    const targetBasedOpts = (gatewayFilter?: string) =>
      baseOpts({
        mode: 'target-based',
        controlTarget: 'ctrl',
        treatmentTarget: 'treat',
        controlOnlineEval: 'quality',
        treatmentOnlineEval: 'quality',
        gatewayFilter,
      });

    it('sets a single target path in config-bundle mode', () => {
      const built = buildABTestRequest(configBundleOpts('/orders/*'), deployed);
      expect(built.gatewayFilter).toEqual({ targetPaths: ['/orders/*'] });
    });

    it('sets a single target path in target-based mode', () => {
      const built = buildABTestRequest(targetBasedOpts('/orders/*'), deployed);
      expect(built.gatewayFilter).toEqual({ targetPaths: ['/orders/*'] });
    });

    it('trims whitespace around the single path', () => {
      const built = buildABTestRequest(targetBasedOpts('  /orders/*  '), deployed);
      expect(built.gatewayFilter).toEqual({ targetPaths: ['/orders/*'] });
    });

    it('throws naming the exact paths when more than one is given', () => {
      expect(() => buildABTestRequest(targetBasedOpts('/a,/b'), deployed)).toThrow(
        /exactly one target path.*Got 2: "\/a", "\/b"/
      );
      expect(() => buildABTestRequest(configBundleOpts('/orders/*, /refunds/*'), deployed)).toThrow(
        /Got 2: "\/orders\/\*", "\/refunds\/\*"/
      );
    });

    it('omits gatewayFilter when not provided in either mode', () => {
      expect(buildABTestRequest(configBundleOpts(), deployed).gatewayFilter).toBeUndefined();
      expect(buildABTestRequest(targetBasedOpts(), deployed).gatewayFilter).toBeUndefined();
    });
  });
});
