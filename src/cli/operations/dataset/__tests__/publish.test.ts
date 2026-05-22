import { publishDataset } from '../publish.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCreateDatasetVersion = vi.fn();
const mockWaitForDatasetActive = vi.fn();
const mockGetDataset = vi.fn();

vi.mock('../../../aws/agentcore-datasets', () => ({
  createDatasetVersion: (...args: unknown[]) => mockCreateDatasetVersion(...args),
  getDataset: (...args: unknown[]) => mockGetDataset(...args),
}));

vi.mock('../wait', () => ({
  waitForDatasetActive: (...args: unknown[]) => mockWaitForDatasetActive(...args),
}));

describe('publishDataset', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls createDatasetVersion, waits for ACTIVE, returns version + count + draftStatus', async () => {
    mockCreateDatasetVersion.mockResolvedValue({
      datasetArn: 'arn:ds:1',
      datasetId: 'ds-1',
      datasetVersion: '3',
      status: 'CREATING',
      createdAt: 1716230000,
    });
    mockWaitForDatasetActive.mockResolvedValue(undefined);
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-1',
      status: 'ACTIVE',
      exampleCount: 50,
      draftStatus: 'UNMODIFIED',
      datasetVersion: 'DRAFT',
    });

    const result = await publishDataset({ region: 'us-east-1', datasetId: 'ds-1' });

    expect(result.version).toBe('3');
    expect(result.exampleCount).toBe(50);
    expect(result.draftStatus).toBe('UNMODIFIED');
    expect(mockCreateDatasetVersion).toHaveBeenCalledWith({ region: 'us-east-1', datasetId: 'ds-1' });
    expect(mockWaitForDatasetActive).toHaveBeenCalledWith('us-east-1', 'ds-1');
  });
});
