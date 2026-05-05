import { waitForRunningThenStop } from '../promote-utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetABTest = vi.fn();
const mockUpdateABTest = vi.fn();

vi.mock('../../../aws/agentcore-ab-tests', () => ({
  getABTest: (...args: unknown[]) => mockGetABTest(...args),
  updateABTest: (...args: unknown[]) => mockUpdateABTest(...args),
}));

describe('waitForRunningThenStop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateABTest.mockResolvedValue({ executionStatus: 'STOPPED' });
  });

  it('stops immediately when already RUNNING', async () => {
    mockGetABTest.mockResolvedValue({ executionStatus: 'RUNNING' });

    await waitForRunningThenStop('us-east-1', 'abt-123', 'MyTest', 3, 0);

    expect(mockGetABTest).toHaveBeenCalledTimes(1);
    expect(mockUpdateABTest).toHaveBeenCalledWith({
      region: 'us-east-1',
      abTestId: 'abt-123',
      executionStatus: 'STOPPED',
    });
  });

  it('polls until RUNNING then stops', async () => {
    mockGetABTest
      .mockResolvedValueOnce({ executionStatus: 'UPDATING' })
      .mockResolvedValueOnce({ executionStatus: 'UPDATING' })
      .mockResolvedValueOnce({ executionStatus: 'RUNNING' });

    await waitForRunningThenStop('us-east-1', 'abt-123', 'MyTest', 5, 0);

    expect(mockGetABTest).toHaveBeenCalledTimes(3);
    expect(mockUpdateABTest).toHaveBeenCalledOnce();
  });

  it('throws if AB test never reaches RUNNING', async () => {
    mockGetABTest.mockResolvedValue({ executionStatus: 'UPDATING' });

    await expect(waitForRunningThenStop('us-east-1', 'abt-123', 'MyTest', 3, 0)).rejects.toThrow(
      'did not reach RUNNING state'
    );

    expect(mockGetABTest).toHaveBeenCalledTimes(3);
    expect(mockUpdateABTest).not.toHaveBeenCalled();
  });

  it('includes current status in the error message', async () => {
    mockGetABTest.mockResolvedValue({ executionStatus: 'STOPPED' });

    await expect(waitForRunningThenStop('us-east-1', 'abt-123', 'MyTest', 2, 0)).rejects.toThrow('current: STOPPED');
  });
});
