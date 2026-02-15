import { checkStackStatus, checkStacksStatus } from '../stack-status.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = mockSend;
  },
  DescribeStacksCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('checkStackStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns canDeploy true for CREATE_COMPLETE', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'CREATE_COMPLETE' }],
    });

    const result = await checkStackStatus('us-east-1', 'MyStack');
    expect(result.canDeploy).toBe(true);
    expect(result.exists).toBe(true);
    expect(result.status).toBe('CREATE_COMPLETE');
  });

  it('returns canDeploy true for UPDATE_COMPLETE', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }],
    });

    const result = await checkStackStatus('us-east-1', 'MyStack');
    expect(result.canDeploy).toBe(true);
  });

  it('returns canDeploy false for in-progress status', async () => {
    const inProgressStatuses = [
      'CREATE_IN_PROGRESS',
      'UPDATE_IN_PROGRESS',
      'DELETE_IN_PROGRESS',
      'ROLLBACK_IN_PROGRESS',
      'UPDATE_ROLLBACK_IN_PROGRESS',
      'REVIEW_IN_PROGRESS',
    ];

    for (const status of inProgressStatuses) {
      mockSend.mockResolvedValue({ Stacks: [{ StackStatus: status }] });
      const result = await checkStackStatus('us-east-1', 'MyStack');
      expect(result.canDeploy, `${status} should block deploy`).toBe(false);
      expect(result.exists).toBe(true);
      expect(result.message).toContain(status);
    }
  });

  it('returns canDeploy false for failed status', async () => {
    const failedStatuses = ['CREATE_FAILED', 'ROLLBACK_FAILED', 'DELETE_FAILED', 'UPDATE_ROLLBACK_FAILED'];

    for (const status of failedStatuses) {
      mockSend.mockResolvedValue({ Stacks: [{ StackStatus: status }] });
      const result = await checkStackStatus('us-east-1', 'MyStack');
      expect(result.canDeploy, `${status} should block deploy`).toBe(false);
      expect(result.message).toContain('Manual intervention');
    }
  });

  it('returns canDeploy true and exists false when stack not found (ValidationError)', async () => {
    const err = new Error('Stack with id MyStack does not exist');
    err.name = 'ValidationError';
    mockSend.mockRejectedValue(err);

    const result = await checkStackStatus('us-east-1', 'MyStack');
    expect(result.canDeploy).toBe(true);
    expect(result.exists).toBe(false);
  });

  it('throws non-ValidationError errors', async () => {
    mockSend.mockRejectedValue(new Error('Access denied'));

    await expect(checkStackStatus('us-east-1', 'MyStack')).rejects.toThrow('Access denied');
  });

  it('handles stack with no StackStatus', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: undefined }],
    });

    const result = await checkStackStatus('us-east-1', 'MyStack');
    expect(result.canDeploy).toBe(true);
    expect(result.exists).toBe(true);
  });

  it('handles empty Stacks array', async () => {
    mockSend.mockResolvedValue({ Stacks: [] });

    const result = await checkStackStatus('us-east-1', 'MyStack');
    expect(result.canDeploy).toBe(true);
    expect(result.exists).toBe(true);
  });
});

describe('checkStacksStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when all stacks are deployable', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'CREATE_COMPLETE' }],
    });

    const result = await checkStacksStatus('us-east-1', ['Stack1', 'Stack2']);
    expect(result).toBeNull();
  });

  it('returns first blocking stack', async () => {
    mockSend
      .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] })
      .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' }] });

    const result = await checkStacksStatus('us-east-1', ['Stack1', 'Stack2']);
    expect(result).not.toBeNull();
    expect(result!.stackName).toBe('Stack2');
    expect(result!.result.canDeploy).toBe(false);
  });

  it('returns null for empty stack list', async () => {
    const result = await checkStacksStatus('us-east-1', []);
    expect(result).toBeNull();
  });
});
