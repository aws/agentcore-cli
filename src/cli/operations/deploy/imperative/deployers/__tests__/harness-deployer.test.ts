import { createHarness, deleteHarness, getHarness, updateHarness } from '../../../../../aws/agentcore-harness';
import { AgentCoreApiError } from '../../../../../aws/api-client';
import type { ImperativeDeployContext } from '../../types';
import { HarnessDeployer } from '../harness-deployer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockImplementation((path: string) => {
    if (path.includes('harness.json')) {
      return Promise.resolve(
        JSON.stringify({
          name: 'my_harness',
          model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet' },
          tools: [],
          skills: [],
        })
      );
    }
    if (path.includes('system-prompt.md')) return Promise.resolve('You are helpful.');
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  }),
}));

vi.mock('../harness-mapper', () => ({
  mapHarnessSpecToCreateOptions: vi.fn().mockResolvedValue({
    harnessName: 'proj_my-harness',
    region: 'us-east-1',
    executionRoleArn: 'arn:aws:iam::111:role/HarnessRole',
    model: { bedrockModelConfig: { modelId: 'anthropic.claude-3-5-sonnet' } },
    systemPrompt: [{ text: 'You are helpful.' }],
  }),
}));

vi.mock('../../../../../aws/agentcore-harness', () => ({
  createHarness: vi.fn().mockResolvedValue({
    harness: {
      harnessId: 'h-123',
      arn: 'arn:aws:bedrock:us-east-1:111:harness/h-123',
      status: 'READY',
      environment: { agentCoreRuntimeEnvironment: { agentRuntimeArn: 'arn:runtime' } },
    },
  }),
  updateHarness: vi.fn().mockResolvedValue({
    harness: {
      harnessId: 'h-existing',
      arn: 'arn:aws:bedrock:us-east-1:111:harness/h-existing',
      status: 'READY',
      environment: { agentCoreRuntimeEnvironment: { agentRuntimeArn: 'arn:runtime' } },
    },
  }),
  deleteHarness: vi.fn().mockResolvedValue({}),
  getHarness: vi.fn().mockResolvedValue({
    harness: {
      harnessId: 'h-123',
      arn: 'arn:aws:bedrock:us-east-1:111:harness/h-123',
      status: 'READY',
      environment: { agentCoreRuntimeEnvironment: { agentRuntimeArn: 'arn:runtime' } },
    },
  }),
}));

function makeContext(overrides: Partial<ImperativeDeployContext> = {}): ImperativeDeployContext {
  return {
    projectSpec: {
      name: 'proj',
      harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
    } as any,
    target: { name: 'dev', region: 'us-east-1' } as any,
    configIO: { getConfigRoot: () => '/project/agentcore' } as any,
    deployedState: { targets: {} } as any,
    cdkOutputs: { ApplicationHarnessMyHarnessRoleArnOutput123: 'arn:aws:iam::111:role/HarnessRole' },
    ...overrides,
  };
}

describe('HarnessDeployer', () => {
  let deployer: HarnessDeployer;

  beforeEach(() => {
    deployer = new HarnessDeployer();
    vi.clearAllMocks();
  });

  describe('shouldRun', () => {
    it('returns true when project has harnesses', () => {
      expect(deployer.shouldRun(makeContext())).toBe(true);
    });

    it('returns true when deployed state has harnesses', () => {
      const ctx = makeContext({
        projectSpec: { name: 'proj', harnesses: [] } as any,
        deployedState: {
          targets: { dev: { resources: { harnesses: { old: { harnessId: 'h-old' } } } } },
        } as any,
      });
      expect(deployer.shouldRun(ctx)).toBe(true);
    });

    it('returns false when no harnesses anywhere', () => {
      const ctx = makeContext({
        projectSpec: { name: 'proj' } as any,
        deployedState: { targets: {} } as any,
      });
      expect(deployer.shouldRun(ctx)).toBe(false);
    });
  });

  describe('deploy - create path', () => {
    it('calls createHarness and returns state on success', async () => {
      const result = await deployer.deploy(makeContext());
      expect(result.success).toBe(true);
      expect(createHarness).toHaveBeenCalled();
      expect(result.state!.my_harness).toMatchObject({
        harnessId: 'h-123',
        status: 'READY',
      });
    });

    it('throws when harness enters FAILED state after create', async () => {
      vi.mocked(createHarness).mockResolvedValueOnce({
        harness: { harnessId: 'h-fail', arn: 'arn:fail', status: 'CREATING' },
      } as any);
      vi.mocked(getHarness).mockResolvedValueOnce({
        harness: { harnessId: 'h-fail', arn: 'arn:fail', status: 'FAILED' },
      } as any);

      const result = await deployer.deploy(makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('FAILED state');
    });
  });

  describe('deploy - update path', () => {
    it('calls updateHarness when existing harness has different configHash', async () => {
      const ctx = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  my_harness: {
                    harnessId: 'h-existing',
                    configHash: 'old-hash',
                    harnessArn: 'arn:old',
                    roleArn: 'arn:role',
                    status: 'READY',
                  },
                },
              },
            },
          },
        } as any,
      });

      const result = await deployer.deploy(ctx);
      expect(result.success).toBe(true);
      expect(updateHarness).toHaveBeenCalled();
      expect(createHarness).not.toHaveBeenCalled();
    });
  });

  describe('deploy - skip path', () => {
    it('skips when configHash matches', async () => {
      // We need to compute the actual hash. Instead, mock readFile to produce deterministic content
      // and set the deployed hash to match. Easiest: just set configHash to what will be computed.
      // Since we can't easily predict the hash, test the logic by verifying no API calls.
      const ctx = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  my_harness: {
                    harnessId: 'h-existing',
                    configHash: 'WILL_NOT_MATCH',
                    harnessArn: 'arn:x',
                    roleArn: 'arn:role',
                    status: 'READY',
                  },
                },
              },
            },
          },
        } as any,
      });

      // To truly test skip, we'd need to know the hash. Let's just verify that when
      // configHash matches, it skips. We'll run once to get the hash, then use it.
      const firstResult = await deployer.deploy(ctx);
      // It will have updated because hash doesn't match
      expect(updateHarness).toHaveBeenCalledTimes(1);

      // Now use the actual computed hash
      vi.clearAllMocks();
      const computedHash = firstResult.state!.my_harness!.configHash;
      const ctx2 = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  my_harness: {
                    harnessId: 'h-existing',
                    configHash: computedHash,
                    harnessArn: 'arn:x',
                    roleArn: 'arn:role',
                    status: 'READY',
                  },
                },
              },
            },
          },
        } as any,
      });

      const result = await deployer.deploy(ctx2);
      expect(result.success).toBe(true);
      expect(createHarness).not.toHaveBeenCalled();
      expect(updateHarness).not.toHaveBeenCalled();
      expect(result.notes).toContain('Harness "my_harness" unchanged, skipped');
    });
  });

  describe('deploy - delete orphaned harnesses', () => {
    it('deletes harnesses not in project spec', async () => {
      const ctx = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  'removed-harness': {
                    harnessId: 'h-removed',
                    configHash: 'x',
                    harnessArn: 'arn:r',
                    roleArn: 'arn:role',
                    status: 'READY',
                  },
                },
              },
            },
          },
        } as any,
      });

      const result = await deployer.deploy(ctx);
      expect(result.success).toBe(true);
      expect(deleteHarness).toHaveBeenCalledWith({ region: 'us-east-1', harnessId: 'h-removed' });
      expect(result.state!['removed-harness']).toBeUndefined();
    });
  });

  describe('deploy - role resolution', () => {
    it('fails when CDK outputs missing role ARN', async () => {
      const ctx = makeContext({ cdkOutputs: {} });
      const result = await deployer.deploy(ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find role ARN');
    });

    it('resolves role from RoleRoleArn output key pattern', async () => {
      const ctx = makeContext({
        cdkOutputs: { ApplicationHarnessMyHarnessRoleArnSomeSuffix: 'arn:aws:iam::111:role/NewRole' },
      });
      const result = await deployer.deploy(ctx);
      expect(result.success).toBe(true);
    });
  });

  describe('deploy - retry logic', () => {
    it('retries on role validation error then succeeds', async () => {
      const roleError = new AgentCoreApiError(400, 'Role validation failed for the given role');
      vi.mocked(createHarness)
        .mockRejectedValueOnce(roleError)
        .mockResolvedValueOnce({
          harness: { harnessId: 'h-retry', arn: 'arn:retry', status: 'READY', environment: {} },
        } as any);

      const result = await deployer.deploy(makeContext());
      expect(result.success).toBe(true);
      expect(createHarness).toHaveBeenCalledTimes(2);
    }, 30_000);

    it('throws non-role-validation errors immediately', async () => {
      vi.mocked(createHarness).mockRejectedValueOnce(new Error('Network failure'));

      const result = await deployer.deploy(makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network failure');
      expect(createHarness).toHaveBeenCalledTimes(1);
    });
  });

  describe('deploy - polling (waitForReady)', () => {
    it('polls getHarness until READY', async () => {
      vi.mocked(createHarness).mockResolvedValueOnce({
        harness: { harnessId: 'h-poll', arn: 'arn:poll', status: 'CREATING' },
      } as any);
      vi.mocked(getHarness)
        .mockResolvedValueOnce({ harness: { harnessId: 'h-poll', arn: 'arn:poll', status: 'CREATING' } } as any)
        .mockResolvedValueOnce({
          harness: {
            harnessId: 'h-poll',
            arn: 'arn:poll',
            status: 'READY',
            environment: { agentCoreRuntimeEnvironment: { agentRuntimeArn: 'arn:rt' } },
          },
        } as any);

      const result = await deployer.deploy(makeContext());
      expect(result.success).toBe(true);
      expect(getHarness).toHaveBeenCalledTimes(2);
    });
  });

  describe('memorySpec resolution', () => {
    const ROLE_ARN = 'arn:aws:iam::123456789012:role/HarnessRole';
    const MEMORY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123';
    const CDK_OUTPUTS = { ApplicationHarnessMyHarnessRoleArnOutput123: ROLE_ARN };
    const READY_HARNESS = {
      harnessId: 'h-new',
      harnessName: 'my_harness',
      arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-new',
      status: 'READY' as const,
      executionRoleArn: ROLE_ARN,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const HARNESS_SPEC_WITH_MEMORY_ARN_JSON = JSON.stringify({
      name: 'my_harness',
      model: { provider: 'bedrock', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
      tools: [],
      skills: [],
      memory: { arn: MEMORY_ARN },
    });

    it('resolves memorySpec by deployed ARN when memory.name is absent', async () => {
      const { readFile: mockedReadFile } = await import('fs/promises');
      const { mapHarnessSpecToCreateOptions: mockedMapHarness } = await import('../harness-mapper');

      vi.mocked(mockedReadFile)
        .mockResolvedValueOnce(HARNESS_SPEC_WITH_MEMORY_ARN_JSON as any)
        .mockRejectedValueOnce(new Error('ENOENT'));
      vi.mocked(mockedMapHarness).mockResolvedValueOnce({
        region: 'us-east-1',
        harnessName: 'my_harness',
        executionRoleArn: ROLE_ARN,
      } as any);
      vi.mocked(createHarness).mockResolvedValueOnce({
        harness: READY_HARNESS,
      } as any);

      const ctx = makeContext({
        projectSpec: {
          name: 'proj',
          harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
          memories: [
            {
              name: 'my_memory',
              eventExpiryDuration: 30,
              strategies: [{ type: 'SEMANTIC', namespaces: ['/users/{actorId}/facts'] }],
            },
          ],
        } as any,
        deployedState: {
          targets: {
            dev: {
              resources: {
                memories: { my_memory: { memoryId: 'mem-123', memoryArn: MEMORY_ARN } },
              },
            },
          },
        } as any,
        cdkOutputs: CDK_OUTPUTS,
      });

      await deployer.deploy(ctx);

      expect(mockedMapHarness).toHaveBeenCalledWith(
        expect.objectContaining({
          memorySpec: {
            name: 'my_memory',
            eventExpiryDuration: 30,
            strategies: [{ type: 'SEMANTIC', namespaces: ['/users/{actorId}/facts'] }],
          },
        })
      );
    });

    it('returns undefined memorySpec for a fully external ARN not in deployedResources', async () => {
      const { readFile: mockedReadFile } = await import('fs/promises');
      const { mapHarnessSpecToCreateOptions: mockedMapHarness } = await import('../harness-mapper');

      vi.mocked(mockedReadFile)
        .mockResolvedValueOnce(HARNESS_SPEC_WITH_MEMORY_ARN_JSON as any)
        .mockRejectedValueOnce(new Error('ENOENT'));
      vi.mocked(mockedMapHarness).mockResolvedValueOnce({
        region: 'us-east-1',
        harnessName: 'my_harness',
        executionRoleArn: ROLE_ARN,
      } as any);
      vi.mocked(createHarness).mockResolvedValueOnce({
        harness: READY_HARNESS,
      } as any);

      const ctx = makeContext({
        projectSpec: {
          name: 'proj',
          harnesses: [{ name: 'my_harness', path: 'harnesses/my_harness' }],
          memories: [],
        } as any,
        cdkOutputs: CDK_OUTPUTS,
      });

      await deployer.deploy(ctx);

      expect(mockedMapHarness).toHaveBeenCalledWith(expect.objectContaining({ memorySpec: undefined }));
    });
  });

  describe('teardown', () => {
    it('deletes all deployed harnesses', async () => {
      const ctx = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  h1: { harnessId: 'id-1', configHash: 'x', harnessArn: 'arn:1', roleArn: 'arn:r', status: 'READY' },
                  h2: { harnessId: 'id-2', configHash: 'y', harnessArn: 'arn:2', roleArn: 'arn:r', status: 'READY' },
                },
              },
            },
          },
        } as any,
      });

      const result = await deployer.teardown(ctx);
      expect(result.success).toBe(true);
      expect(deleteHarness).toHaveBeenCalledTimes(2);
      expect(result.state).toEqual({});
    });

    it('returns error if delete fails', async () => {
      vi.mocked(deleteHarness).mockRejectedValueOnce(new Error('Access denied'));
      const ctx = makeContext({
        deployedState: {
          targets: {
            dev: {
              resources: {
                harnesses: {
                  h1: { harnessId: 'id-1', configHash: 'x', harnessArn: 'arn:1', roleArn: 'arn:r', status: 'READY' },
                },
              },
            },
          },
        } as any,
      });

      const result = await deployer.teardown(ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });
});
