import type { ABTestJobRecord } from '../../shared/types';
import { promoteABTestConfig } from '../promote';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ConfigIO — vi.hoisted ensures these are available before the hoisted vi.mock runs
const { mockReadProjectSpec, mockWriteProjectSpec, mockReadDeployedState, mockGetConfigurationBundleVersion } =
  vi.hoisted(() => ({
    mockReadProjectSpec: vi.fn(),
    mockWriteProjectSpec: vi.fn(),
    mockReadDeployedState: vi.fn(),
    mockGetConfigurationBundleVersion: vi.fn(),
  }));

vi.mock('../../../../../lib', () => {
  class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readDeployedState = mockReadDeployedState;
  }
  return { ConfigIO: MockConfigIO };
});

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
    vi.clearAllMocks();
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

    it('returns promoted=true without writing (or fetching) for a valid config-bundle promote', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());
      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: BUNDLE_ARN, bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record, true);
      expect(result.promoted).toBe(true);
      // dry-run must not touch the service or write the spec
      expect(mockGetConfigurationBundleVersion).not.toHaveBeenCalled();
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
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
