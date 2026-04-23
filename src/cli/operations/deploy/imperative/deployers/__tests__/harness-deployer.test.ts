import type { ConfigIO } from '../../../../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTarget, DeployedState } from '../../../../../../schema';
import * as harnessApi from '../../../../../aws/agentcore-harness';
import type { ImperativeDeployContext } from '../../types';
import { HarnessDeployer } from '../harness-deployer';
import * as harnessMapper from '../harness-mapper';
import { readFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../../../../aws/agentcore-harness', () => ({
  createHarness: vi.fn(),
  updateHarness: vi.fn(),
  deleteHarness: vi.fn(),
  getHarness: vi.fn(),
}));

vi.mock('../harness-mapper', () => ({
  mapHarnessSpecToCreateOptions: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedCreateHarness = vi.mocked(harnessApi.createHarness);
const mockedUpdateHarness = vi.mocked(harnessApi.updateHarness);
const mockedDeleteHarness = vi.mocked(harnessApi.deleteHarness);
const mockedGetHarness = vi.mocked(harnessApi.getHarness);
const mockedMapHarness = vi.mocked(harnessMapper.mapHarnessSpecToCreateOptions);

const REGION = 'us-east-1';
const TARGET_NAME = 'default';
const CONFIG_ROOT = '/project/agentcore';

function createContext(overrides?: {
  harnesses?: AgentCoreProjectSpec['harnesses'];
  deployedHarnesses?: DeployedState['targets'][string]['resources'];
  cdkOutputs?: Record<string, string>;
}): ImperativeDeployContext {
  const projectSpec = {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    harnesses: overrides?.harnesses,
  } as AgentCoreProjectSpec;

  const target: AwsDeploymentTarget = {
    name: TARGET_NAME,
    account: '123456789012',
    region: REGION,
  };

  const deployedState: DeployedState = {
    targets: {
      [TARGET_NAME]: {
        resources: overrides?.deployedHarnesses ?? {},
      },
    },
  };

  const configIO = {
    getConfigRoot: () => CONFIG_ROOT,
    getPathResolver: () => ({ getBaseDir: () => CONFIG_ROOT }),
  } as unknown as ConfigIO;

  return {
    projectSpec,
    target,
    deployedState,
    configIO,
    cdkOutputs: overrides?.cdkOutputs ?? {},
  };
}

const HARNESS_SPEC_JSON = JSON.stringify({
  name: 'my_harness',
  model: { provider: 'bedrock', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
  tools: [],
  skills: [],
});

describe('HarnessDeployer', () => {
  let deployer: HarnessDeployer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    deployer = new HarnessDeployer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('metadata', () => {
    it('has correct name, label, and phase', () => {
      expect(deployer.name).toBe('harness');
      expect(deployer.label).toBe('Harnesses');
      expect(deployer.phase).toBe('post-cdk');
    });
  });

  describe('shouldRun', () => {
    it('returns true when project has harnesses', () => {
      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
      });
      expect(deployer.shouldRun(ctx)).toBe(true);
    });

    it('returns true when only deployed state has harnesses', () => {
      const ctx = createContext({
        deployedHarnesses: {
          harnesses: {
            old_harness: {
              harnessId: 'h-123',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-123',
              roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
              status: 'READY',
            },
          },
        },
      });
      expect(deployer.shouldRun(ctx)).toBe(true);
    });

    it('returns false when no harnesses anywhere', () => {
      const ctx = createContext();
      expect(deployer.shouldRun(ctx)).toBe(false);
    });

    it('returns false when harnesses array is empty', () => {
      const ctx = createContext({ harnesses: [] });
      expect(deployer.shouldRun(ctx)).toBe(false);
    });
  });

  describe('deploy', () => {
    it('creates a harness when not previously deployed', async () => {
      const createOptions = {
        region: REGION,
        harnessName: 'my_harness',
        executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
        model: { bedrockModelConfig: { modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' } },
      };

      mockedReadFile.mockResolvedValueOnce(HARNESS_SPEC_JSON);
      mockedMapHarness.mockResolvedValueOnce(createOptions);
      mockedCreateHarness.mockResolvedValueOnce({
        harness: {
          harnessId: 'h-new',
          harnessName: 'my_harness',
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-new',
          status: 'CREATING',
          executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      });
      mockedGetHarness.mockResolvedValueOnce({
        harness: {
          harnessId: 'h-new',
          harnessName: 'my_harness',
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-new',
          status: 'READY',
          executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          environment: {
            agentCoreRuntimeEnvironment: {
              agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-new',
            },
          },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      });

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const resultPromise = deployer.deploy(ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.state).toEqual({
        my_harness: expect.objectContaining({
          harnessId: 'h-new',
          harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-new',
          roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          status: 'READY',
          agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-new',
          memoryArn: undefined,
        }),
      });
      expect(result.state!.my_harness).toHaveProperty('configHash');
      expect(mockedCreateHarness).toHaveBeenCalledWith(createOptions);
      expect(result.notes).toContain('Created harness "my_harness"');
    });

    it('updates a harness when already deployed', async () => {
      const createOptions = {
        region: REGION,
        harnessName: 'my_harness',
        executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
        model: { bedrockModelConfig: { modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' } },
      };

      mockedReadFile.mockResolvedValueOnce(HARNESS_SPEC_JSON);
      mockedMapHarness.mockResolvedValueOnce(createOptions);
      mockedUpdateHarness.mockResolvedValueOnce({
        harness: {
          harnessId: 'h-existing',
          harnessName: 'my_harness',
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
          status: 'UPDATING',
          executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      });
      mockedGetHarness.mockResolvedValueOnce({
        harness: {
          harnessId: 'h-existing',
          harnessName: 'my_harness',
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
          status: 'READY',
          executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          environment: {
            agentCoreRuntimeEnvironment: {
              agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-existing',
            },
          },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      });

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        deployedHarnesses: {
          harnesses: {
            my_harness: {
              harnessId: 'h-existing',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
              roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
              status: 'READY',
            },
          },
        },
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const resultPromise = deployer.deploy(ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(mockedUpdateHarness).toHaveBeenCalledWith(
        expect.objectContaining({
          region: REGION,
          harnessId: 'h-existing',
        })
      );
      expect(result.notes).toContain('Updated harness "my_harness"');
    });

    it('deletes a harness removed from project spec', async () => {
      mockedDeleteHarness.mockResolvedValueOnce({
        harness: {
          harnessId: 'h-old',
          harnessName: 'old_harness',
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-old',
          status: 'DELETING',
          executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      });

      const ctx = createContext({
        harnesses: [],
        deployedHarnesses: {
          harnesses: {
            old_harness: {
              harnessId: 'h-old',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-old',
              roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
              status: 'READY',
            },
          },
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(true);
      expect(mockedDeleteHarness).toHaveBeenCalledWith({ region: REGION, harnessId: 'h-old' });
      expect(result.notes).toContain('Deleted harness "old_harness"');
      // Deleted harness should not appear in result state
      expect(result.state).toEqual({});
    });

    it('returns error when role ARN not found in CDK outputs', async () => {
      mockedReadFile.mockResolvedValueOnce(HARNESS_SPEC_JSON);

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        cdkOutputs: {
          // No matching output key
          SomeOtherOutput: 'value',
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find role ARN');
      expect(result.error).toContain('my_harness');
    });

    it('returns error when harness.json cannot be read', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to read harness.json');
    });

    it('preserves existing harness state when validation fails', async () => {
      mockedReadFile.mockResolvedValueOnce('{ "invalid": true }');

      const existingState = {
        harnessId: 'h-existing',
        harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
        roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
        status: 'READY' as const,
        configHash: 'abc123',
      };

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        deployedHarnesses: {
          harnesses: { my_harness: existingState },
        },
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.state).toEqual({ my_harness: existingState });
    });

    it('preserves existing harness state when harness.json read fails', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const existingState = {
        harnessId: 'h-existing',
        harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
        roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
        status: 'READY' as const,
        configHash: 'abc123',
      };

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        deployedHarnesses: {
          harnesses: { my_harness: existingState },
        },
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.state).toEqual({ my_harness: existingState });
    });

    it('preserves existing harness state when role ARN not found', async () => {
      mockedReadFile.mockResolvedValueOnce(HARNESS_SPEC_JSON);

      const existingState = {
        harnessId: 'h-existing',
        harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-existing',
        roleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
        status: 'READY' as const,
        configHash: 'abc123',
      };

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        deployedHarnesses: {
          harnesses: { my_harness: existingState },
        },
        cdkOutputs: { SomeOtherOutput: 'value' },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.state).toEqual({ my_harness: existingState });
    });

    it('returns error when API call fails', async () => {
      mockedReadFile.mockResolvedValueOnce(HARNESS_SPEC_JSON);
      mockedMapHarness.mockResolvedValueOnce({
        region: REGION,
        harnessName: 'my_harness',
        executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
      });
      mockedCreateHarness.mockRejectedValueOnce(new Error('Service unavailable'));

      const ctx = createContext({
        harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
        cdkOutputs: {
          ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::123456789012:role/HarnessRole',
        },
      });

      const result = await deployer.deploy(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to deploy harness "my_harness"');
      expect(result.error).toContain('Service unavailable');
    });
  });

  describe('teardown', () => {
    it('deletes all deployed harnesses', async () => {
      mockedDeleteHarness
        .mockResolvedValueOnce({
          harness: {
            harnessId: 'h-1',
            harnessName: 'harness_a',
            arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1',
            status: 'DELETING',
            executionRoleArn: 'arn:aws:iam::123456789012:role/RoleA',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        })
        .mockResolvedValueOnce({
          harness: {
            harnessId: 'h-2',
            harnessName: 'harness_b',
            arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-2',
            status: 'DELETING',
            executionRoleArn: 'arn:aws:iam::123456789012:role/RoleB',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        });

      const ctx = createContext({
        deployedHarnesses: {
          harnesses: {
            harness_a: {
              harnessId: 'h-1',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1',
              roleArn: 'arn:aws:iam::123456789012:role/RoleA',
              status: 'READY',
            },
            harness_b: {
              harnessId: 'h-2',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-2',
              roleArn: 'arn:aws:iam::123456789012:role/RoleB',
              status: 'READY',
            },
          },
        },
      });

      const result = await deployer.teardown(ctx);

      expect(result.success).toBe(true);
      expect(result.state).toEqual({});
      expect(mockedDeleteHarness).toHaveBeenCalledTimes(2);
      expect(result.notes).toContain('Deleted harness "harness_a"');
      expect(result.notes).toContain('Deleted harness "harness_b"');
    });

    it('returns error when delete fails during teardown', async () => {
      mockedDeleteHarness.mockRejectedValueOnce(new Error('Access denied'));

      const ctx = createContext({
        deployedHarnesses: {
          harnesses: {
            bad_harness: {
              harnessId: 'h-bad',
              harnessArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-bad',
              roleArn: 'arn:aws:iam::123456789012:role/Role',
              status: 'READY',
            },
          },
        },
      });

      const result = await deployer.teardown(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to delete harness "bad_harness"');
    });

    it('succeeds with empty state when no harnesses are deployed', async () => {
      const ctx = createContext();

      const result = await deployer.teardown(ctx);

      expect(result.success).toBe(true);
      expect(result.state).toEqual({});
      expect(mockedDeleteHarness).not.toHaveBeenCalled();
    });
  });
});
