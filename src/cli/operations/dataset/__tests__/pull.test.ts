import { pullDataset } from '../pull.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetDataset = vi.fn();
const mockDownloadDataset = vi.fn();

vi.mock('../../../aws/agentcore-datasets', () => ({
  getDataset: (...args: unknown[]) => mockGetDataset(...args),
  downloadDataset: (...args: unknown[]) => mockDownloadDataset(...args),
}));

describe('pullDataset', () => {
  afterEach(() => vi.clearAllMocks());

  it('throws when dataset status is not ACTIVE', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-1',
      status: 'CREATING',
      datasetVersion: 'DRAFT',
    });

    await expect(
      pullDataset({
        region: 'us-east-1',
        datasetId: 'ds-1',
        localFilePath: 'datasets/test.jsonl',
        configBaseDir: '/project',
      })
    ).rejects.toThrow('Dataset is not ready (status: CREATING)');
  });

  it('throws when no downloadUrl available', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-1',
      status: 'ACTIVE',
      datasetVersion: 'DRAFT',
      downloadUrl: undefined,
    });

    await expect(
      pullDataset({
        region: 'us-east-1',
        datasetId: 'ds-1',
        localFilePath: 'datasets/test.jsonl',
        configBaseDir: '/project',
      })
    ).rejects.toThrow('Dataset has no download URL available');
  });

  it('streams to file and returns exampleCount and version', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-1',
      status: 'ACTIVE',
      datasetVersion: '2',
      downloadUrl: 'https://s3.example.com/data',
    });
    mockDownloadDataset.mockResolvedValue(42);

    const result = await pullDataset({
      region: 'us-east-1',
      datasetId: 'ds-1',
      localFilePath: 'datasets/test.jsonl',
      configBaseDir: '/project',
    });

    expect(result.exampleCount).toBe(42);
    expect(result.version).toBe('2');
    expect(mockDownloadDataset).toHaveBeenCalledWith('https://s3.example.com/data', {
      mode: 'stream',
      filePath: expect.stringContaining('datasets/test.jsonl'),
    });
  });
});
