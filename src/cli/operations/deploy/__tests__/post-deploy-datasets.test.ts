import { syncDatasets } from '../post-deploy-datasets.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockPushDataset = vi.fn();
const mockReadFile = vi.fn();

vi.mock('../../dataset', () => ({
  pushDataset: (...args: unknown[]) => mockPushDataset(...args),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

function makeDataset(name: string) {
  return {
    name,
    schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1' as const,
    config: { managed: { location: `datasets/${name}.jsonl` } },
  };
}

describe('syncDatasets', () => {
  afterEach(() => vi.clearAllMocks());

  it('skips dataset when contentHash matches', async () => {
    // We need to compute the actual sha256 hash for the content
    const content = '{"input":"hello"}\n';
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update(content).digest('hex');

    mockReadFile.mockResolvedValue(content);

    const result = await syncDatasets({
      region: 'us-east-1',
      datasets: [makeDataset('ds1')],
      deployedDatasets: {
        ds1: { datasetId: 'ds-1', datasetArn: 'arn:ds:1', contentHash: expectedHash },
      },
      configBaseDir: '/project',
    });

    expect(result.results[0]!.status).toBe('skipped');
    expect(mockPushDataset).not.toHaveBeenCalled();
  });

  it('calls pushDataset and updates hash when content changed', async () => {
    mockReadFile.mockResolvedValue('{"input":"new content"}\n');
    mockPushDataset.mockResolvedValue({ added: 1, updated: 0, deleted: 0, unchanged: 0, totalRemote: 1 });

    const result = await syncDatasets({
      region: 'us-east-1',
      datasets: [makeDataset('ds1')],
      deployedDatasets: {
        ds1: { datasetId: 'ds-1', datasetArn: 'arn:ds:1', contentHash: 'old-hash-value' },
      },
      configBaseDir: '/project',
    });

    expect(result.results[0]!.status).toBe('synced');
    expect(result.results[0]!.added).toBe(1);
    expect(mockPushDataset).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        datasetId: 'ds-1',
      })
    );
    // Updated datasets should contain new hash
    expect(result.updatedDatasets.ds1!.contentHash).not.toBe('old-hash-value');
  });

  it('records error and continues when push throws', async () => {
    mockReadFile.mockResolvedValue('{"input":"data"}\n');
    mockPushDataset.mockRejectedValue(new Error('Push failed: network error'));

    const result = await syncDatasets({
      region: 'us-east-1',
      datasets: [makeDataset('ds1')],
      deployedDatasets: {
        ds1: { datasetId: 'ds-1', datasetArn: 'arn:ds:1', contentHash: 'old-hash' },
      },
      configBaseDir: '/project',
    });

    expect(result.hasErrors).toBe(true);
    expect(result.results[0]!.status).toBe('error');
    expect(result.results[0]!.error).toBe('Push failed: network error');
  });

  it('skips datasets not present in deployed state', async () => {
    const result = await syncDatasets({
      region: 'us-east-1',
      datasets: [makeDataset('missing')],
      deployedDatasets: {},
      configBaseDir: '/project',
    });

    expect(result.results).toHaveLength(0);
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
