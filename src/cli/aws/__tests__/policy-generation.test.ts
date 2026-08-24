import { getPolicyGeneration } from '../policy-generation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockWaitUntilPolicyGenerationCompleted } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWaitUntilPolicyGenerationCompleted: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  GetPolicyGenerationCommand: class {
    constructor(public input: unknown) {}
  },
  ListPolicyGenerationAssetsCommand: class {
    constructor(public input: unknown) {}
  },
  StartPolicyGenerationCommand: class {
    constructor(public input: unknown) {}
  },
  waitUntilPolicyGenerationCompleted: mockWaitUntilPolicyGenerationCompleted,
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('getPolicyGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWaitUntilPolicyGenerationCompleted.mockResolvedValue({ state: 'SUCCESS' });
  });

  it('returns a generated Cedar definition statement', async () => {
    mockSend.mockResolvedValueOnce({ status: 'GENERATED' }).mockResolvedValueOnce({
      policyGenerationAssets: [
        {
          definition: {
            cedar: { statement: 'permit(principal, action, resource);' },
          },
        },
      ],
    });

    await expect(
      getPolicyGeneration({
        generationId: 'generation-1',
        policyEngineId: 'engine-1',
        region: 'us-east-1',
      })
    ).resolves.toEqual({
      status: 'GENERATED',
      statement: 'permit(principal, action, resource);',
    });
  });

  it('returns a generated Policy definition statement', async () => {
    mockSend.mockResolvedValueOnce({ status: 'GENERATED' }).mockResolvedValueOnce({
      policyGenerationAssets: [
        {
          definition: {
            policy: { statement: 'forbid(principal, action, resource);' },
          },
        },
      ],
    });

    await expect(
      getPolicyGeneration({
        generationId: 'generation-1',
        policyEngineId: 'engine-1',
        region: 'us-west-2',
      })
    ).resolves.toEqual({
      status: 'GENERATED',
      statement: 'forbid(principal, action, resource);',
    });
  });

  it('surfaces findings when generation produces no statement', async () => {
    mockSend.mockResolvedValueOnce({ status: 'GENERATED' }).mockResolvedValueOnce({
      policyGenerationAssets: [
        {
          findings: [
            {
              type: 'INVALID',
              description: 'Non-translatable: cannot be expressed in Dogwood',
            },
          ],
        },
      ],
    });

    await expect(
      getPolicyGeneration({
        generationId: 'generation-1',
        policyEngineId: 'engine-1',
        region: 'us-west-2',
      })
    ).rejects.toThrow('Non-translatable: cannot be expressed in Dogwood');
  });
});
