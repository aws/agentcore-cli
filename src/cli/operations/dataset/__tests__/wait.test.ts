import { waitForDatasetActive } from '../wait.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetDataset = vi.fn();

vi.mock('../../../aws/agentcore-datasets', () => ({
  getDataset: (...args: unknown[]) => mockGetDataset(...args),
}));

describe('waitForDatasetActive', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves immediately when status is ACTIVE', async () => {
    mockGetDataset.mockResolvedValue({ status: 'ACTIVE' });

    await waitForDatasetActive('us-east-1', 'ds-1');

    expect(mockGetDataset).toHaveBeenCalledTimes(1);
  });

  it('throws on terminal _FAILED status', async () => {
    mockGetDataset.mockResolvedValue({ status: 'CREATE_FAILED' });

    await expect(waitForDatasetActive('us-east-1', 'ds-1')).rejects.toThrow(
      'Dataset entered failed state: CREATE_FAILED'
    );
  });

  it('throws timeout error after maxWaitMs', async () => {
    // Mock Date.now to simulate time passing
    const originalNow = Date.now;
    let currentTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // Advance time on each call so the while loop condition fails
      const val = currentTime;
      currentTime += 70_000; // jump past default maxWaitMs on second call
      return val;
    });

    mockGetDataset.mockResolvedValue({ status: 'CREATING' });

    await expect(waitForDatasetActive('us-east-1', 'ds-1', 60_000)).rejects.toThrow(
      'Timed out waiting for dataset to become ACTIVE'
    );

    Date.now = originalNow;
  });
});
