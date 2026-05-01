import { promoteABTestConfig } from '../promote';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ConfigIO — vi.hoisted ensures these are available before the hoisted vi.mock runs
const { mockReadProjectSpec, mockWriteProjectSpec, mockReadDeployedState } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockReadDeployedState: vi.fn(),
}));

vi.mock('../../../../lib', () => {
  class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readDeployedState = mockReadDeployedState;
  }
  return { ConfigIO: MockConfigIO };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigBundleProject(testName = 'myTest') {
  return {
    name: 'TestProject',
    runtimes: [],
    httpGateways: [],
    onlineEvalConfigs: [],
    abTests: [
      {
        name: testName,
        mode: 'config-bundle' as const,
        gatewayRef: '{{gateway:my-gw}}',
        variants: [
          {
            name: 'C' as const,
            weight: 50,
            variantConfiguration: {
              configurationBundle: { bundleArn: 'arn:aws:bundle:control', bundleVersion: 'v1' },
            },
          },
          {
            name: 'T1' as const,
            weight: 50,
            variantConfiguration: {
              configurationBundle: { bundleArn: 'arn:aws:bundle:treatment', bundleVersion: 'v2' },
            },
          },
        ],
        evaluationConfig: { onlineEvaluationConfigArn: 'arn:aws:eval:config' },
      },
    ],
  };
}

function makeTargetBasedProject(testName = 'targetTest') {
  return {
    name: 'TestProject',
    runtimes: [
      {
        name: 'my-runtime',
        endpoints: {
          control: { version: '1.0' },
          treatment: { version: '2.0' },
        },
      },
    ],
    httpGateways: [
      {
        name: 'my-gw',
        targets: [
          { name: 'ctrl-target', runtimeRef: 'my-runtime', qualifier: 'control' },
          { name: 'treat-target', runtimeRef: 'my-runtime', qualifier: 'treatment' },
        ],
      },
    ],
    onlineEvalConfigs: [],
    abTests: [
      {
        name: testName,
        mode: 'target-based' as const,
        gatewayRef: '{{gateway:my-gw}}',
        variants: [
          {
            name: 'C' as const,
            weight: 50,
            variantConfiguration: { target: { targetName: 'ctrl-target' } },
          },
          {
            name: 'T1' as const,
            weight: 50,
            variantConfiguration: { target: { targetName: 'treat-target' } },
          },
        ],
        evaluationConfig: {
          perVariantOnlineEvaluationConfig: [
            { treatmentName: 'C' as const, onlineEvaluationConfigArn: 'eval-c' },
            { treatmentName: 'T1' as const, onlineEvaluationConfigArn: 'eval-t1' },
          ],
        },
      },
    ],
  };
}

function makeDeployedState(specName: string, abTestId: string) {
  return {
    targets: {
      default: {
        resources: {
          abTests: {
            [specName]: { abTestId, abTestArn: `arn:aws:ab-test:${abTestId}` },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promoteABTestConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteProjectSpec.mockResolvedValue(undefined);
  });

  describe('target-based promote', () => {
    it('updates control endpoint version to treatment version', async () => {
      const project = makeTargetBasedProject();
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue(makeDeployedState('targetTest', 'ab-123'));

      const result = await promoteABTestConfig('ab-123');

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('target-based');
      expect(result.promotionDetail).toContain('control');
      expect(result.promotionDetail).toContain('2.0');

      // Verify the project was written with updated control version
      expect(mockWriteProjectSpec).toHaveBeenCalledOnce();
      const writtenProject = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenProject.runtimes[0].endpoints.control.version).toBe('2.0');
    });
  });

  describe('config-bundle promote', () => {
    it('copies treatment bundle ref to control', async () => {
      const project = makeConfigBundleProject();
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue(makeDeployedState('myTest', 'ab-456'));

      const result = await promoteABTestConfig('ab-456');

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('config-bundle');
      expect(result.promotionDetail).toContain('arn:aws:bundle:treatment');
      expect(result.promotionDetail).toContain('v2');

      // Verify the control bundle was updated
      expect(mockWriteProjectSpec).toHaveBeenCalledOnce();
      const writtenProject = mockWriteProjectSpec.mock.calls[0]![0];
      const controlVariant = writtenProject.abTests[0].variants.find((v: { name: string }) => v.name === 'C');
      expect(controlVariant.variantConfiguration.configurationBundle.bundleArn).toBe('arn:aws:bundle:treatment');
      expect(controlVariant.variantConfiguration.configurationBundle.bundleVersion).toBe('v2');
    });
  });

  describe('not found', () => {
    it('returns promoted=false with message when AB test not found', async () => {
      const project = makeConfigBundleProject();
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue({ targets: { default: { resources: { abTests: {} } } } });

      const result = await promoteABTestConfig('nonexistent-id');

      expect(result.promoted).toBe(false);
      expect(result.promotionDetail).toContain('not found');
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('ID-based lookup from deployed state', () => {
    it('resolves spec name from deployed state using abTestId', async () => {
      const project = makeConfigBundleProject('mySpecTest');
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue(makeDeployedState('mySpecTest', 'ab-789'));

      const result = await promoteABTestConfig('ab-789');

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('config-bundle');
      // Should have resolved without needing testNameFallback
      expect(mockWriteProjectSpec).toHaveBeenCalledOnce();
    });

    it('searches across multiple targets in deployed state', async () => {
      const project = makeConfigBundleProject('crossTarget');
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockResolvedValue({
        targets: {
          'us-east-1': { resources: { abTests: {} } },
          'us-west-2': {
            resources: {
              abTests: {
                crossTarget: { abTestId: 'ab-cross', abTestArn: 'arn:aws:ab-test:ab-cross' },
              },
            },
          },
        },
      });

      const result = await promoteABTestConfig('ab-cross');

      expect(result.promoted).toBe(true);
    });
  });

  describe('name fallback when deployed state missing', () => {
    it('falls back to name-based lookup when deployed state throws', async () => {
      const project = makeConfigBundleProject('fallbackTest');
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockRejectedValue(new Error('No deployed state'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      const result = await promoteABTestConfig('unknown-id', 'fallbackTest');

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('config-bundle');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to name'));

      warnSpy.mockRestore();
    });

    it('falls back to prefixed name match', async () => {
      const project = makeConfigBundleProject('myTest');
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockRejectedValue(new Error('No deployed state'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      // testNameFallback uses the prefixed format {projectName}_{testName}
      const result = await promoteABTestConfig('unknown-id', 'TestProject_myTest');

      expect(result.promoted).toBe(true);

      warnSpy.mockRestore();
    });

    it('returns not found when neither deployed state nor name matches', async () => {
      const project = makeConfigBundleProject('myTest');
      mockReadProjectSpec.mockResolvedValue(project);
      mockReadDeployedState.mockRejectedValue(new Error('No deployed state'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      const result = await promoteABTestConfig('unknown-id', 'nonexistent');

      expect(result.promoted).toBe(false);
      expect(result.promotionDetail).toContain('not found');

      warnSpy.mockRestore();
    });
  });
});
