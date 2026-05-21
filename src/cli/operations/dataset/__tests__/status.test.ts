import { getDatasetStatus } from '../status';
import { describe, expect, it, vi } from 'vitest';

const mockGetDataset = vi.fn();
const mockListDatasetVersions = vi.fn();

vi.mock('../../../aws/agentcore-datasets', () => ({
  getDataset: (...args: unknown[]) => mockGetDataset(...args),
  listDatasetVersions: (...args: unknown[]) => mockListDatasetVersions(...args),
}));

describe('getDatasetStatus', () => {
  it('returns correct structure with name, datasetId, schemaType, status, draftExampleCount, draftStatus, updatedAt, and versions', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-123',
      datasetArn: 'arn:aws:bedrock:us-east-1:123456789:dataset/ds-123',
      datasetName: 'my-dataset',
      datasetVersion: 'DRAFT',
      schemaType: 'CONVERSATIONAL',
      status: 'ACTIVE',
      draftStatus: 'READY',
      exampleCount: 42,
      createdAt: 1716230000,
      updatedAt: 1716235200,
    });

    mockListDatasetVersions.mockResolvedValue({
      versions: [
        {
          datasetVersion: '1',
          exampleCount: 30,
          status: 'AVAILABLE',
          createdAt: 1716220000,
        },
        {
          datasetVersion: '2',
          exampleCount: 42,
          status: 'AVAILABLE',
          createdAt: 1716230000,
        },
      ],
    });

    const result = await getDatasetStatus({
      region: 'us-east-1',
      datasetId: 'ds-123',
      name: 'my-dataset',
    });

    expect(result).toEqual({
      name: 'my-dataset',
      datasetId: 'ds-123',
      schemaType: 'CONVERSATIONAL',
      status: 'ACTIVE',
      draftExampleCount: 42,
      draftStatus: 'READY',
      updatedAt: 1716235200,
      versions: [
        {
          datasetVersion: '1',
          exampleCount: 30,
          status: 'AVAILABLE',
          createdAt: 1716220000,
        },
        {
          datasetVersion: '2',
          exampleCount: 42,
          status: 'AVAILABLE',
          createdAt: 1716230000,
        },
      ],
    });
  });

  it('handles empty versions list', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-456',
      datasetArn: 'arn:aws:bedrock:us-east-1:123456789:dataset/ds-456',
      datasetName: 'empty-dataset',
      datasetVersion: 'DRAFT',
      schemaType: 'CONVERSATIONAL',
      status: 'ACTIVE',
      draftStatus: 'READY',
      exampleCount: 5,
      createdAt: 1716230000,
      updatedAt: 1716235000,
    });

    mockListDatasetVersions.mockResolvedValue({
      versions: [],
    });

    const result = await getDatasetStatus({
      region: 'us-east-1',
      datasetId: 'ds-456',
      name: 'empty-dataset',
    });

    expect(result.versions).toEqual([]);
  });

  it('passes through updatedAt from getDataset', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-789',
      datasetArn: 'arn:aws:bedrock:us-east-1:123456789:dataset/ds-789',
      datasetName: 'dated-dataset',
      datasetVersion: 'DRAFT',
      schemaType: 'CONVERSATIONAL',
      status: 'ACTIVE',
      draftStatus: 'READY',
      exampleCount: 10,
      createdAt: 1716220000,
      updatedAt: 1716235200,
    });

    mockListDatasetVersions.mockResolvedValue({
      versions: [],
    });

    const result = await getDatasetStatus({
      region: 'us-east-1',
      datasetId: 'ds-789',
      name: 'dated-dataset',
    });

    expect(result.updatedAt).toBe(1716235200);
  });

  it('passes through version failureReason', async () => {
    mockGetDataset.mockResolvedValue({
      datasetId: 'ds-fail',
      datasetArn: 'arn:aws:bedrock:us-east-1:123456789:dataset/ds-fail',
      datasetName: 'failed-dataset',
      datasetVersion: 'DRAFT',
      schemaType: 'CONVERSATIONAL',
      status: 'ACTIVE',
      draftStatus: 'READY',
      exampleCount: 10,
      createdAt: 1716220000,
      updatedAt: 1716230000,
    });

    mockListDatasetVersions.mockResolvedValue({
      versions: [
        {
          datasetVersion: '1',
          exampleCount: 10,
          status: 'FAILED',
          failureReason: 'Content validation error',
          createdAt: 1716225000,
        },
      ],
    });

    const result = await getDatasetStatus({
      region: 'us-east-1',
      datasetId: 'ds-fail',
      name: 'failed-dataset',
    });

    expect(result.versions[0]!.failureReason).toBe('Content validation error');
  });

  it('handles API errors gracefully by propagating them', async () => {
    mockGetDataset.mockRejectedValue(new Error('Dataset API error (403): Access denied'));

    mockListDatasetVersions.mockResolvedValue({
      versions: [],
    });

    await expect(
      getDatasetStatus({
        region: 'us-east-1',
        datasetId: 'ds-error',
        name: 'error-dataset',
      })
    ).rejects.toThrow('Dataset API error (403): Access denied');
  });
});
