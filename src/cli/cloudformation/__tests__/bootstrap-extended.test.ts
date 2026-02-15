import { checkBootstrapStatus } from '../bootstrap.js';
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

describe('checkBootstrapStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isBootstrapped true for CREATE_COMPLETE', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'CREATE_COMPLETE' }],
    });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(true);
    expect(result.stackStatus).toBe('CREATE_COMPLETE');
  });

  it('returns isBootstrapped true for UPDATE_COMPLETE', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }],
    });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(true);
  });

  it('returns isBootstrapped true for UPDATE_ROLLBACK_COMPLETE', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'UPDATE_ROLLBACK_COMPLETE' }],
    });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(true);
  });

  it('returns isBootstrapped false for in-progress status', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'CREATE_IN_PROGRESS' }],
    });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(false);
    expect(result.stackStatus).toBe('CREATE_IN_PROGRESS');
  });

  it('returns isBootstrapped false for failed status', async () => {
    mockSend.mockResolvedValue({
      Stacks: [{ StackStatus: 'ROLLBACK_FAILED' }],
    });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(false);
  });

  it('returns isBootstrapped false when no stacks returned', async () => {
    mockSend.mockResolvedValue({ Stacks: [] });

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(false);
  });

  it('returns isBootstrapped false when stack not found (ValidationError)', async () => {
    const err = new Error('Stack does not exist');
    err.name = 'ValidationError';
    mockSend.mockRejectedValue(err);

    const result = await checkBootstrapStatus('us-east-1');
    expect(result.isBootstrapped).toBe(false);
  });

  it('throws non-ValidationError errors', async () => {
    mockSend.mockRejectedValue(new Error('Network error'));

    await expect(checkBootstrapStatus('us-east-1')).rejects.toThrow('Network error');
  });
});
