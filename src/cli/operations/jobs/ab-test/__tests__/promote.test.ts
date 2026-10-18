import { ConfigIO } from '../../../../../lib';
import type { ABTestJobRecord } from '../../shared/types';
import { MAX_CONFIG_BUNDLE_DATA_BYTES } from '../constants';
import { abTestHandler } from '../handler';
import { promoteABTestConfig } from '../promote';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ConfigIO — vi.hoisted ensures these are available before the hoisted vi.mock runs
const {
  mockReadProjectSpec,
  mockWriteProjectSpec,
  mockReadDeployedState,
  mockGetConfigurationBundleVersion,
  mockGetABTest,
  mockUpdateABTest,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockReadDeployedState: vi.fn(),
  mockGetConfigurationBundleVersion: vi.fn(),
  mockGetABTest: vi.fn(),
  mockUpdateABTest: vi.fn(),
}));

vi.mock('../../../../../lib', async importOriginal => {
  class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readDeployedState = mockReadDeployedState;
  }
  return { ...(await importOriginal<Record<string, unknown>>()), ConfigIO: MockConfigIO };
});

vi.mock('../../../../aws/agentcore-ab-tests', () => ({
  getABTest: mockGetABTest,
  updateABTest: mockUpdateABTest,
  createABTest: vi.fn(),
  deleteABTest: vi.fn(),
  listABTests: vi.fn(),
}));

vi.mock('../../../../aws/agentcore-config-bundles', () => ({
  getConfigurationBundleVersion: mockGetConfigurationBundleVersion,
}));

// ---------------------------------------------------------------------------
// Helpers — promote is now RECORD-DRIVEN: it reads the job record's variants,
// not project.abTests[] (which the jobs model never populates).
// ---------------------------------------------------------------------------

function baseRecord(overrides: Partial<ABTestJobRecord>): ABTestJobRecord {
  return {
    type: 'ab-test',
    id: 'ab-123',
    arn: 'arn:aws:bedrock-agentcore:us-east-1:1:ab-test/ab-123',
    status: 'STOPPED',
    lifecycleStatus: 'STOPPED',
    createdAt: '2026-01-01T00:00:00Z',
    agent: 'my-agent',
    name: 'myTest',
    mode: 'config-bundle',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:1:gateway/my-gw',
    variants: [],
    evaluationConfig: { onlineEvaluationConfigArn: 'arn:aws:eval:config' },
    ...overrides,
  };
}

function makeTargetBasedProject() {
  return {
    name: 'TestProject',
    runtimes: [
      {
        name: 'my-runtime',
        endpoints: {
          control: { version: 1 },
          treatment: { version: 2 },
        },
      },
    ],
    agentCoreGateways: [
      {
        name: 'my-gw',
        targets: [
          {
            name: 'ctrl-target',
            targetType: 'httpRuntime',
            httpRuntime: { runtime: 'my-runtime', runtimeEndpoint: 'control' },
          },
          {
            name: 'treat-target',
            targetType: 'httpRuntime',
            httpRuntime: { runtime: 'my-runtime', runtimeEndpoint: 'treatment' },
          },
        ],
      },
    ],
    onlineEvalConfigs: [],
    configBundles: [],
    abTests: [],
  };
}

// A config-bundle A/B test promotes between two VERSIONS of ONE bundle, so both variants share the
// same bundleArn; only bundleVersion differs.
const BUNDLE_ARN = 'arn:aws:bedrock-agentcore:us-east-1:1:configuration-bundle/promptBundle-abc123';

function makeConfigBundleProject() {
  return {
    name: 'TestProject',
    runtimes: [],
    agentCoreGateways: [],
    onlineEvalConfigs: [],
    configBundles: [
      {
        name: 'promptBundle',
        type: 'ConfigurationBundle',
        components: { '{{runtime:r}}': { configuration: { systemPrompt: 'OLD' } } },
      },
    ],
    abTests: [],
  };
}

function makeBundleDeployedState() {
  return {
    targets: {
      default: {
        resources: {
          configBundles: {
            promptBundle: { bundleId: 'promptBundle-abc123', bundleArn: BUNDLE_ARN, versionId: 'v1' },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promoteABTestConfig (record-driven)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteProjectSpec.mockResolvedValue(undefined);
  });

  describe('target-based promote', () => {
    it('bumps control endpoint version to treatment version', async () => {
      mockReadProjectSpec.mockResolvedValue(makeTargetBasedProject());

      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('target-based');
      expect(result.promotionDetail).toContain('control');
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      expect(written.runtimes[0].endpoints.control.version).toBe(2);
    });

    it('repoints control to the treatment runtime when variants target different runtimes', async () => {
      // Control → runtime-a (endpoint prod), Treatment → runtime-b (endpoint prod). No shared
      // runtime to version-bump, so promote clones treatment's httpRuntime onto the control target.
      const project = {
        name: 'TestProject',
        runtimes: [
          { name: 'runtime-a', endpoints: { prod: { version: 1 } } },
          { name: 'runtime-b', endpoints: { prod: { version: 5 } } },
        ],
        agentCoreGateways: [
          {
            name: 'my-gw',
            targets: [
              {
                name: 'ctrl-target',
                targetType: 'httpRuntime',
                httpRuntime: { runtime: 'runtime-a', runtimeEndpoint: 'prod' },
              },
              {
                name: 'treat-target',
                targetType: 'httpRuntime',
                httpRuntime: { runtime: 'runtime-b', runtimeEndpoint: 'prod' },
              },
            ],
          },
        ],
        onlineEvalConfigs: [],
        configBundles: [],
        abTests: [],
      };
      mockReadProjectSpec.mockResolvedValue(project);

      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      const ctrl = written.agentCoreGateways[0].targets.find((t: { name: string }) => t.name === 'ctrl-target');
      expect(ctrl.httpRuntime.runtime).toBe('runtime-b');
      expect(ctrl.httpRuntime.runtimeEndpoint).toBe('prod');
    });

    it('repoints control when variants use the default (unnamed) endpoint', async () => {
      // Neither target names a runtimeEndpoint → no endpoints[name].version to bump → repoint path.
      const project = {
        name: 'TestProject',
        runtimes: [
          { name: 'runtime-a', endpoints: {} },
          { name: 'runtime-b', endpoints: {} },
        ],
        agentCoreGateways: [
          {
            name: 'my-gw',
            targets: [
              { name: 'ctrl-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'runtime-a' } },
              { name: 'treat-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'runtime-b' } },
            ],
          },
        ],
        onlineEvalConfigs: [],
        configBundles: [],
        abTests: [],
      };
      mockReadProjectSpec.mockResolvedValue(project);

      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      const ctrl = written.agentCoreGateways[0].targets.find((t: { name: string }) => t.name === 'ctrl-target');
      expect(ctrl.httpRuntime.runtime).toBe('runtime-b');
    });

    it('returns promoted=false when the gateway name is missing from the record', async () => {
      mockReadProjectSpec.mockResolvedValue(makeTargetBasedProject());
      const record = baseRecord({
        mode: 'target-based',
        gatewayName: undefined,
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('config-bundle promote', () => {
    it('adopts the winning (treatment) version components into the bundle (same bundle, diff version)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      // The service returns the treatment version's components.
      mockGetConfigurationBundleVersion.mockResolvedValue({
        components: { '{{runtime:r}}': { configuration: { systemPrompt: 'NEW' } } },
      });

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('config-bundle');
      // Fetched the WINNING (treatment) version v2 from the bundle id parsed from the ARN.
      expect(mockGetConfigurationBundleVersion).toHaveBeenCalledWith(
        expect.objectContaining({ bundleId: 'promptBundle-abc123', versionId: 'v2' })
      );
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      const bundle = written.configBundles.find((b: { name: string }) => b.name === 'promptBundle');
      expect(bundle.components['{{runtime:r}}'].configuration.systemPrompt).toBe('NEW');
    });

    it('restores portable {{runtime:...}} keys when the service returns ARN-keyed components', async () => {
      const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/cbbugbash_cbagent-N5owhv3MRl';
      const project = makeConfigBundleProject();
      // Local bundle uses the portable placeholder for the runtime named "r".
      project.configBundles[0]!.components = { '{{runtime:r}}': { configuration: { systemPrompt: 'OLD' } } };
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue({
        targets: {
          default: {
            resources: {
              configBundles: {
                promptBundle: { bundleId: 'promptBundle-abc123', bundleArn: BUNDLE_ARN, versionId: 'v1' },
              },
              runtimes: { r: { runtimeArn: RUNTIME_ARN } },
            },
          },
        },
      });
      // Service keys the winning version's components by the resolved (hardcoded) runtime ARN.
      mockGetConfigurationBundleVersion.mockResolvedValue({
        components: { [RUNTIME_ARN]: { configuration: { systemPrompt: 'NEW' } } },
      });

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      const bundle = written.configBundles.find((b: { name: string }) => b.name === 'promptBundle');
      // Placeholder preserved, ARN NOT written into the committed config.
      expect(bundle.components['{{runtime:r}}'].configuration.systemPrompt).toBe('NEW');
      expect(bundle.components[RUNTIME_ARN]).toBeUndefined();
    });

    it('returns promoted=false (error) when control and treatment are DIFFERENT bundles', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          {
            name: 'C',
            weight: 50,
            bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:configuration-bundle/bundleA',
            bundleVersion: 'v1',
          },
          {
            name: 'T1',
            weight: 50,
            bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:configuration-bundle/bundleB',
            bundleVersion: 'v1',
          },
        ],
      });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(result.promotionDetail).toContain('different config bundles');
      expect(mockGetConfigurationBundleVersion).not.toHaveBeenCalled();
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('returns promoted=false when the bundle cannot be resolved from deployed state', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue({ targets: { default: { resources: { configBundles: {} } } } });

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('malformed record', () => {
    it('returns promoted=false when control/treatment variants are missing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      const record = baseRecord({ mode: 'config-bundle', variants: [] });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  // BUG-4: promote must validate the winner is applicable BEFORE stopping the test. The dry-run
  // path returns the same promoted/detail as a real run but never writes agentcore.json.
  describe('dry run (pre-stop preflight)', () => {
    it.each(['escaping', 'multiple-components'])('counts JSON overhead across %s', async kind => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      const components =
        kind === 'escaping'
          ? { 'arn:runtime': { configuration: { systemPrompt: '"'.repeat(1800) } } }
          : {
              'arn:runtime-a': { configuration: { systemPrompt: 'x'.repeat(1600) } },
              'arn:runtime-b': { configuration: { systemPrompt: 'y'.repeat(1600) } },
            };
      mockGetConfigurationBundleVersion.mockResolvedValue({ components });
      const result = await promoteABTestConfig(
        baseRecord({
          variants: [
            { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
            { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
          ],
        }),
        true
      );
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('preserves unrelated edits made between preflight and applying the winner', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      mockGetConfigurationBundleVersion.mockResolvedValue({
        components: { 'arn:runtime': { configuration: { systemPrompt: 'NEW' } } },
      });
      const record = baseRecord({
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });
      const preflight = await promoteABTestConfig(record, true);
      const current = { ...makeConfigBundleProject(), description: 'concurrent unrelated edit' };
      mockReadProjectSpec.mockResolvedValue(current);
      await preflight.apply!();
      expect(mockWriteProjectSpec).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'concurrent unrelated edit' })
      );
    });

    it('does not overwrite a bundle changed while stopping and reports the stopped state', async () => {
      const project = makeConfigBundleProject();
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      mockGetConfigurationBundleVersion.mockResolvedValue({
        components: { 'arn:runtime': { configuration: { systemPrompt: 'NEW' } } },
      });
      mockGetABTest.mockResolvedValue({ executionStatus: 'RUNNING' });
      mockUpdateABTest.mockImplementation(() => {
        project.configBundles[0]!.components['{{runtime:r}}'].configuration.systemPrompt = 'user edit';
        return Promise.resolve({});
      });
      const result = await abTestHandler.promote(
        baseRecord({
          variants: [
            { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
            { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
          ],
        }),
        new ConfigIO()
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('is stopped');
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      expect(project.configBundles[0]!.components['{{runtime:r}}'].configuration.systemPrompt).toBe('user edit');
    });
    it('returns promoted=true without writing for a valid target-based promote', async () => {
      mockReadProjectSpec.mockResolvedValue(makeTargetBasedProject());
      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record, true);
      expect(result.promoted).toBe(true);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('returns promoted=false without writing when a target is missing its httpRuntime entirely', async () => {
      // No httpRuntime.runtime on either target → nothing to copy from/to → not promotable.
      const project = makeTargetBasedProject();
      for (const gw of project.agentCoreGateways) {
        for (const t of gw.targets) {
          delete (t as { httpRuntime?: unknown }).httpRuntime;
        }
      }
      mockReadProjectSpec.mockResolvedValue(project);
      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record, true);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('fetches and validates a valid config-bundle winner without writing during preflight', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      mockGetConfigurationBundleVersion.mockResolvedValue({
        components: { 'arn:runtime': { configuration: { systemPrompt: 'NEW' } } },
      });
      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record, true);
      expect(result.promoted).toBe(true);
      expect(mockGetConfigurationBundleVersion).toHaveBeenCalledTimes(1);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it.each([false, true])('rejects oversized UTF-8 components without mutation (dryRun=%s)', async dryRun => {
      const project = makeConfigBundleProject();
      const original = structuredClone(project);
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      const components = { 'arn:runtime': { configuration: { systemPrompt: '界'.repeat(1400) } } };
      expect(JSON.stringify(components).length).toBeLessThan(MAX_CONFIG_BUNDLE_DATA_BYTES);
      mockGetConfigurationBundleVersion.mockResolvedValue({ components });
      const record = baseRecord({
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });
      const result = await promoteABTestConfig(record, dryRun);
      expect(result.promoted).toBe(false);
      expect(result.promotionDetail).toContain('bytes');
      expect(result.promotionDetail).not.toContain('界');
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      expect(project).toEqual(original);
    });

    it.each([MAX_CONFIG_BUNDLE_DATA_BYTES, MAX_CONFIG_BUNDLE_DATA_BYTES + 1])(
      'checks the serialized Data.Value boundary at %s bytes',
      async bytes => {
        const components = { 'arn:runtime': { configuration: { systemPrompt: '' } } };
        const overhead = Buffer.byteLength(
          JSON.stringify({ Value: { 'arn:runtime': { Configuration: { systemPrompt: '' } } } })
        );
        components['arn:runtime'].configuration.systemPrompt = 'x'.repeat(bytes - overhead);
        mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
        mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
        mockGetConfigurationBundleVersion.mockResolvedValue({ components });
        const record = baseRecord({
          variants: [
            { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
            { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
          ],
        });
        const result = await promoteABTestConfig(record, true);
        expect(result.promoted).toBe(bytes === MAX_CONFIG_BUNDLE_DATA_BYTES);
        expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      }
    );

    it.each(['oversized', 'fetch-failed'])(
      'leaves the running test and config untouched when preflight is %s',
      async failure => {
        mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
        mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
        if (failure === 'fetch-failed')
          mockGetConfigurationBundleVersion.mockRejectedValue(new Error('cannot read winner'));
        else
          mockGetConfigurationBundleVersion.mockResolvedValue({
            components: { 'arn:runtime': { configuration: { systemPrompt: 'x'.repeat(5000) } } },
          });
        const record = baseRecord({
          variants: [
            { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
            { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
          ],
        });
        const result = await abTestHandler.promote(record, new ConfigIO());
        expect(result.success).toBe(false);
        expect(mockGetABTest).not.toHaveBeenCalled();
        expect(mockUpdateABTest).not.toHaveBeenCalled();
        expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      }
    );

    it('applies the same preflight payload exactly once after stopping the test', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      mockGetConfigurationBundleVersion
        .mockResolvedValueOnce({
          components: { 'arn:runtime': { configuration: { systemPrompt: 'validated winner' } } },
        })
        .mockRejectedValueOnce(new Error('must not refetch after stopping'));
      mockGetABTest.mockResolvedValue({ executionStatus: 'RUNNING' });
      mockUpdateABTest.mockResolvedValue({});
      const record = baseRecord({
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });
      const result = await abTestHandler.promote(record, new ConfigIO());
      expect(result.success).toBe(true);
      expect(mockGetConfigurationBundleVersion).toHaveBeenCalledTimes(1);
      expect(mockUpdateABTest).toHaveBeenCalledTimes(1);
      expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
      expect(mockGetConfigurationBundleVersion.mock.invocationCallOrder[0]).toBeLessThan(
        mockUpdateABTest.mock.invocationCallOrder[0]!
      );
      expect(mockUpdateABTest.mock.invocationCallOrder[0]).toBeLessThan(
        mockWriteProjectSpec.mock.invocationCallOrder[0]!
      );
    });

    it('returns promoted=false without writing when control/treatment are different bundles (dry-run)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          {
            name: 'C',
            weight: 50,
            bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:configuration-bundle/bundleA',
            bundleVersion: 'v1',
          },
          {
            name: 'T1',
            weight: 50,
            bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:1:configuration-bundle/bundleB',
            bundleVersion: 'v1',
          },
        ],
      });

      const result = await promoteABTestConfig(record, true);
      expect(result.promoted).toBe(false);
      expect(result.promotionDetail).toContain('different config bundles');
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });
});
