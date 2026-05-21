import { PollFailureError, PollTimeoutError, pollUntilTerminal } from '../poll.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockStatus {
  status: string;
  reason?: string;
}

describe('pollUntilTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately when first result is terminal', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'READY' });

    const result = await pollUntilTerminal<MockStatus>({
      fn,
      isTerminal: (r: MockStatus) => r.status === 'READY',
    });

    expect(result).toEqual({ status: 'READY' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('polls until terminal status is reached', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ status: 'CREATING' })
      .mockResolvedValueOnce({ status: 'CREATING' })
      .mockResolvedValueOnce({ status: 'READY' });

    const result = await pollUntilTerminal<MockStatus>({
      fn,
      isTerminal: (r: MockStatus) => ['READY', 'FAILED'].includes(r.status),
      intervalMs: 10,
    });

    expect(result).toEqual({ status: 'READY' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws PollFailureError when failure state is detected', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'FAILED', reason: 'bad config' });

    await expect(
      pollUntilTerminal<MockStatus>({
        fn,
        isTerminal: (r: MockStatus) => ['READY', 'FAILED'].includes(r.status),
        isFailure: (r: MockStatus) => r.status === 'FAILED',
        getFailureReason: (r: MockStatus) => `Harness failed: ${r.reason}`,
        intervalMs: 10,
      })
    ).rejects.toThrow(PollFailureError);

    await expect(
      pollUntilTerminal<MockStatus>({
        fn,
        isTerminal: (r: MockStatus) => ['READY', 'FAILED'].includes(r.status),
        isFailure: (r: MockStatus) => r.status === 'FAILED',
        getFailureReason: (r: MockStatus) => `Harness failed: ${r.reason}`,
        intervalMs: 10,
      })
    ).rejects.toThrow('Harness failed: bad config');
  });

  it('throws PollTimeoutError when maxWaitMs exceeded', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'CREATING' });

    await expect(
      pollUntilTerminal<MockStatus>({
        fn,
        isTerminal: (r: MockStatus) => r.status === 'READY',
        intervalMs: 10,
        maxWaitMs: 50,
      })
    ).rejects.toThrow(PollTimeoutError);
  });

  it('uses default failure message when getFailureReason is not provided', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'FAILED' });

    await expect(
      pollUntilTerminal<MockStatus>({
        fn,
        isTerminal: (r: MockStatus) => r.status === 'FAILED',
        isFailure: (r: MockStatus) => r.status === 'FAILED',
        intervalMs: 10,
      })
    ).rejects.toThrow('Resource entered a failed state');
  });
});
