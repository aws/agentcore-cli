import { getStackOutputs, getStackOutputsByProject } from '../outputs.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCfnSend, mockTagSend } = vi.hoisted(() => ({
  mockCfnSend: vi.fn(),
  mockTagSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = mockCfnSend;
  },
  DescribeStacksCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-resource-groups-tagging-api', () => ({
  ResourceGroupsTaggingAPIClient: class {
    send = mockTagSend;
  },
  GetResourcesCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('getStackOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns outputs as key-value map', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [
        {
          Outputs: [
            { OutputKey: 'Key1', OutputValue: 'Value1' },
            { OutputKey: 'Key2', OutputValue: 'Value2' },
          ],
        },
      ],
    });

    const outputs = await getStackOutputs('us-east-1', 'MyStack');
    expect(outputs).toEqual({ Key1: 'Value1', Key2: 'Value2' });
  });

  it('throws when stack not found', async () => {
    mockCfnSend.mockResolvedValue({ Stacks: [] });

    await expect(getStackOutputs('us-east-1', 'MissingStack')).rejects.toThrow('Stack MissingStack not found');
  });

  it('returns empty object when no outputs', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: [] }],
    });

    const outputs = await getStackOutputs('us-east-1', 'MyStack');
    expect(outputs).toEqual({});
  });

  it('skips outputs with missing keys or values', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [
        {
          Outputs: [
            { OutputKey: 'Valid', OutputValue: 'Value' },
            { OutputKey: undefined, OutputValue: 'NoKey' },
            { OutputKey: 'NoValue', OutputValue: undefined },
          ],
        },
      ],
    });

    const outputs = await getStackOutputs('us-east-1', 'MyStack');
    expect(outputs).toEqual({ Valid: 'Value' });
  });

  it('handles null Outputs', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: null }],
    });

    const outputs = await getStackOutputs('us-east-1', 'MyStack');
    expect(outputs).toEqual({});
  });
});

describe('getStackOutputsByProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers stack and returns outputs', async () => {
    // Mock tag API to find stack
    mockTagSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/FoundStack/guid',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'MyProject' },
            { Key: 'agentcore:target-name', Value: 'default' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    // Mock CFN to return outputs
    mockCfnSend.mockResolvedValue({
      Stacks: [
        {
          Outputs: [{ OutputKey: 'Out1', OutputValue: 'Val1' }],
        },
      ],
    });

    const outputs = await getStackOutputsByProject('us-east-1', 'MyProject');
    expect(outputs).toEqual({ Out1: 'Val1' });
  });

  it('throws when no stack found for project', async () => {
    mockTagSend.mockResolvedValue({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    await expect(getStackOutputsByProject('us-east-1', 'MissingProject')).rejects.toThrow(
      'No AgentCore stack found for project "MissingProject" target "default"'
    );
  });

  it('uses custom target name', async () => {
    mockTagSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/ProdStack/guid',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'MyProject' },
            { Key: 'agentcore:target-name', Value: 'prod' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    mockCfnSend.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'A', OutputValue: 'B' }] }],
    });

    const outputs = await getStackOutputsByProject('us-east-1', 'MyProject', 'prod');
    expect(outputs).toEqual({ A: 'B' });
  });
});
