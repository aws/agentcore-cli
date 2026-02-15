// Import after mocks are set up
import { discoverStacksByProject, findStack, getStackName } from '../stack-discovery.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so the mock is available when vi.mock factory runs (hoisted above imports)
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

// Mock the AWS SDK client - use a class so `new` works
vi.mock('@aws-sdk/client-resource-groups-tagging-api', () => {
  return {
    ResourceGroupsTaggingAPIClient: class {
      send = mockSend;
    },
    GetResourcesCommand: class {
      constructor(public input: unknown) {}
    },
  };
});

// Mock the credential provider
vi.mock('../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('discoverStacksByProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stacks matching project name', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123456789012:stack/MyProject-default/guid-123',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'MyProject' },
            { Key: 'agentcore:target-name', Value: 'default' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'MyProject');
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.stackName).toBe('MyProject-default');
    expect(stacks[0]!.targetName).toBe('default');
    expect(stacks[0]!.stackArn).toContain('arn:aws:cloudformation');
  });

  it('returns multiple stacks for different targets', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Proj-dev/guid1',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'dev' },
          ],
        },
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Proj-prod/guid2',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'prod' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'Proj');
    expect(stacks).toHaveLength(2);
    expect(stacks.map(s => s.targetName)).toEqual(['dev', 'prod']);
  });

  it('returns empty array when no stacks found', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'NonExistent');
    expect(stacks).toEqual([]);
  });

  it('defaults target name to "default" when tag not present', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/MyStack/guid',
          Tags: [{ Key: 'agentcore:project-name', Value: 'MyProject' }],
        },
      ],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'MyProject');
    expect(stacks[0]!.targetName).toBe('default');
  });

  it('skips resources without ResourceARN', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        { ResourceARN: undefined, Tags: [] },
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Valid/guid',
          Tags: [{ Key: 'agentcore:project-name', Value: 'P' }],
        },
      ],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'P');
    expect(stacks).toHaveLength(1);
  });

  it('skips non-stack ARNs (e.g. stackset)', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stackset/MyStackSet:guid',
          Tags: [{ Key: 'agentcore:project-name', Value: 'P' }],
        },
      ],
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'P');
    expect(stacks).toEqual([]);
  });

  it('handles pagination across multiple pages', async () => {
    mockSend
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack1/guid1',
            Tags: [
              { Key: 'agentcore:project-name', Value: 'P' },
              { Key: 'agentcore:target-name', Value: 'dev' },
            ],
          },
        ],
        PaginationToken: 'next-page-token',
      })
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack2/guid2',
            Tags: [
              { Key: 'agentcore:project-name', Value: 'P' },
              { Key: 'agentcore:target-name', Value: 'prod' },
            ],
          },
        ],
        PaginationToken: undefined,
      });

    const stacks = await discoverStacksByProject('us-east-1', 'P');
    expect(stacks).toHaveLength(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('handles null ResourceTagMappingList', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: null,
      PaginationToken: undefined,
    });

    const stacks = await discoverStacksByProject('us-east-1', 'P');
    expect(stacks).toEqual([]);
  });
});

describe('findStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching stack for target', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack-dev/guid1',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'dev' },
          ],
        },
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack-prod/guid2',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'prod' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const stack = await findStack('us-east-1', 'Proj', 'prod');
    expect(stack).not.toBeNull();
    expect(stack!.stackName).toBe('Stack-prod');
    expect(stack!.targetName).toBe('prod');
  });

  it('returns null when target not found', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack-dev/guid',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'dev' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const stack = await findStack('us-east-1', 'Proj', 'staging');
    expect(stack).toBeNull();
  });

  it('defaults to "default" target', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/Stack/guid',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'default' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const stack = await findStack('us-east-1', 'Proj');
    expect(stack!.targetName).toBe('default');
  });
});

describe('getStackName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stack name for found stack', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [
        {
          ResourceARN: 'arn:aws:cloudformation:us-east-1:123:stack/MyStack/guid',
          Tags: [
            { Key: 'agentcore:project-name', Value: 'Proj' },
            { Key: 'agentcore:target-name', Value: 'default' },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const name = await getStackName('us-east-1', 'Proj');
    expect(name).toBe('MyStack');
  });

  it('returns null when no stack found', async () => {
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const name = await getStackName('us-east-1', 'NonExistent');
    expect(name).toBeNull();
  });
});
