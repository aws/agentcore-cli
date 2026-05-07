import { recoverReviewInProgressStack } from '../stack-cleanup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, DescribeStacksCommand, ListChangeSetsCommand, DeleteStackCommand } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  DescribeStacksCommand: class {
    constructor(public input: unknown) {}
  },
  ListChangeSetsCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteStackCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = mockSend;
  },
  DescribeStacksCommand,
  ListChangeSetsCommand,
  DeleteStackCommand,
}));

vi.mock('../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('recoverReviewInProgressStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeClient() {
    return { send: mockSend } as unknown as Parameters<typeof recoverReviewInProgressStack>[2] extends infer O
      ? O extends { client?: infer C }
        ? C
        : never
      : never;
  }

  it('deletes stack when REVIEW_IN_PROGRESS and all change sets failed', async () => {
    // describe
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    // list change sets - one FAILED
    mockSend.mockResolvedValueOnce({ Summaries: [{ Status: 'FAILED', ExecutionStatus: 'UNAVAILABLE' }] });
    // delete stack
    mockSend.mockResolvedValueOnce({});
    // poll - stack no longer exists
    const validationErr = new Error('Stack does not exist');
    validationErr.name = 'ValidationError';
    mockSend.mockRejectedValueOnce(validationErr);

    const result = await recoverReviewInProgressStack('us-east-1', 'MyStack', {
      pollIntervalMs: 1,
      timeoutMs: 1000,
      client: makeClient(),
    });

    expect(result.deleted).toBe(true);
    expect(result.changeSetCount).toBe(1);
    expect(result.allChangeSetsNonExecuted).toBe(true);

    // Verify DeleteStackCommand was sent
    const deleteCalls = mockSend.mock.calls.filter(c => c[0] instanceof DeleteStackCommand);
    expect(deleteCalls.length).toBe(1);
  });

  it('throws when stack is not in REVIEW_IN_PROGRESS', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] });
    await expect(recoverReviewInProgressStack('us-east-1', 'MyStack', { client: makeClient() })).rejects.toThrow(
      /expected status REVIEW_IN_PROGRESS/
    );
  });

  it('throws when stack does not exist at all', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [] });
    await expect(recoverReviewInProgressStack('us-east-1', 'MyStack', { client: makeClient() })).rejects.toThrow(
      /not found/
    );
  });

  it('refuses to delete when a change set has been executed', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({
      Summaries: [{ Status: 'CREATE_COMPLETE', ExecutionStatus: 'EXECUTE_COMPLETE' }],
    });

    await expect(recoverReviewInProgressStack('us-east-1', 'MyStack', { client: makeClient() })).rejects.toThrow(
      /at least one change set has been executed/
    );

    // Ensure delete was not called
    const deleteCalls = mockSend.mock.calls.filter(c => c[0] instanceof DeleteStackCommand);
    expect(deleteCalls.length).toBe(0);
  });

  it('handles paginated change set lists', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({
      Summaries: [{ Status: 'FAILED' }],
      NextToken: 'page-2',
    });
    mockSend.mockResolvedValueOnce({
      Summaries: [{ Status: 'OBSOLETE' }],
    });
    mockSend.mockResolvedValueOnce({}); // delete
    const validationErr = new Error('Stack does not exist');
    validationErr.name = 'ValidationError';
    mockSend.mockRejectedValueOnce(validationErr); // poll

    const result = await recoverReviewInProgressStack('us-east-1', 'MyStack', {
      pollIntervalMs: 1,
      timeoutMs: 1000,
      client: makeClient(),
    });
    expect(result.deleted).toBe(true);
    expect(result.changeSetCount).toBe(2);
  });

  it('handles DELETE_FAILED during poll', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({ Summaries: [{ Status: 'FAILED' }] });
    mockSend.mockResolvedValueOnce({}); // delete
    mockSend.mockResolvedValueOnce({
      Stacks: [{ StackStatus: 'DELETE_FAILED', StackStatusReason: 'permission denied' }],
    });

    await expect(
      recoverReviewInProgressStack('us-east-1', 'MyStack', {
        pollIntervalMs: 1,
        timeoutMs: 1000,
        client: makeClient(),
      })
    ).rejects.toThrow(/Failed to delete stack/);
  });

  it('proceeds with deletion when ListChangeSets returns no summaries (with warning)', async () => {
    // CloudFormation may auto-purge old change sets; REVIEW_IN_PROGRESS itself
    // is sufficient evidence that the stack contains no resources.
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({ Summaries: [] });
    mockSend.mockResolvedValueOnce({}); // delete
    const validationErr = new Error('Stack does not exist');
    validationErr.name = 'ValidationError';
    mockSend.mockRejectedValueOnce(validationErr);

    const warnings: string[] = [];
    const result = await recoverReviewInProgressStack('us-east-1', 'MyStack', {
      pollIntervalMs: 1,
      timeoutMs: 1000,
      client: makeClient(),
      onWarning: msg => warnings.push(msg),
    });
    expect(result.deleted).toBe(true);
    expect(result.changeSetCount).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('no change sets');
    const deleteCalls = mockSend.mock.calls.filter(c => c[0] instanceof DeleteStackCommand);
    expect(deleteCalls.length).toBe(1);
  });

  it('treats Status=CREATE_COMPLETE + ExecutionStatus=AVAILABLE as recoverable', async () => {
    // This is the typical shape of the change set that *put* the stack into
    // REVIEW_IN_PROGRESS in the first place — created successfully but never
    // executed (e.g. the user is recovering from a prior early-validation
    // failure flow).
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({
      Summaries: [{ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE' }],
    });
    mockSend.mockResolvedValueOnce({}); // delete
    const validationErr = new Error('Stack does not exist');
    validationErr.name = 'ValidationError';
    mockSend.mockRejectedValueOnce(validationErr);

    const result = await recoverReviewInProgressStack('us-east-1', 'MyStack', {
      pollIntervalMs: 1,
      timeoutMs: 1000,
      client: makeClient(),
    });
    expect(result.deleted).toBe(true);
    expect(result.allChangeSetsNonExecuted).toBe(true);
  });

  it('treats ExecutionStatus=EXECUTE_FAILED as recoverable', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({
      Summaries: [{ Status: 'CREATE_COMPLETE', ExecutionStatus: 'EXECUTE_FAILED' }],
    });
    mockSend.mockResolvedValueOnce({}); // delete
    const validationErr = new Error('Stack does not exist');
    validationErr.name = 'ValidationError';
    mockSend.mockRejectedValueOnce(validationErr);

    const result = await recoverReviewInProgressStack('us-east-1', 'MyStack', {
      pollIntervalMs: 1,
      timeoutMs: 1000,
      client: makeClient(),
    });
    expect(result.deleted).toBe(true);
  });

  it('throws a Timed out error when the deadline elapses without delete completing', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({ Summaries: [{ Status: 'FAILED' }] });
    mockSend.mockResolvedValueOnce({}); // delete
    // Subsequent describes always return DELETE_IN_PROGRESS
    mockSend.mockResolvedValue({ Stacks: [{ StackStatus: 'DELETE_IN_PROGRESS' }] });

    await expect(
      recoverReviewInProgressStack('us-east-1', 'MyStack', {
        pollIntervalMs: 1,
        timeoutMs: 5,
        client: makeClient(),
      })
    ).rejects.toThrow(/Timed out waiting for stack/);
  });

  it('re-throws non-ValidationError errors raised by DescribeStacks during polling', async () => {
    mockSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] });
    mockSend.mockResolvedValueOnce({ Summaries: [{ Status: 'FAILED' }] });
    mockSend.mockResolvedValueOnce({}); // delete
    const accessDenied = new Error('Access denied');
    accessDenied.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(accessDenied);

    await expect(
      recoverReviewInProgressStack('us-east-1', 'MyStack', {
        pollIntervalMs: 1,
        timeoutMs: 1000,
        client: makeClient(),
      })
    ).rejects.toThrow(/Access denied/);
  });
});
