import {
  getDataSource,
  getKnowledgeBase,
  getLatestIngestionJob,
  listDataSources,
  listIngestionJobs,
  startIngestionJob,
} from '../bedrock-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class {
    send = mockSend;
  },
  GetKnowledgeBaseCommand: class {
    constructor(public readonly input: unknown) {}
  },
  GetDataSourceCommand: class {
    constructor(public readonly input: unknown) {}
  },
  ListDataSourcesCommand: class {
    constructor(public readonly input: unknown) {}
  },
  ListIngestionJobsCommand: class {
    constructor(public readonly input: unknown) {}
  },
  GetIngestionJobCommand: class {
    constructor(public readonly input: unknown) {}
  },
  StartIngestionJobCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('bedrock-agent wrapper', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('getKnowledgeBase', () => {
    it('returns the knowledge base when present', async () => {
      mockSend.mockResolvedValueOnce({
        knowledgeBase: { knowledgeBaseId: 'KB123', name: 'docs', status: 'ACTIVE' },
      });
      const result = await getKnowledgeBase({ region: 'us-west-2', knowledgeBaseId: 'KB123' });
      expect(result?.knowledgeBaseId).toBe('KB123');
      expect(result?.status).toBe('ACTIVE');
    });

    it('returns null when KB not found', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
      const result = await getKnowledgeBase({ region: 'us-west-2', knowledgeBaseId: 'KBMISSING' });
      expect(result).toBeNull();
    });

    it('rethrows other errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('throttled'));
      await expect(getKnowledgeBase({ region: 'us-west-2', knowledgeBaseId: 'KB1' })).rejects.toThrow('throttled');
    });
  });

  describe('getDataSource', () => {
    it('returns the data source when present', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: { dataSourceId: 'DS1', knowledgeBaseId: 'KB1', name: 'ds', status: 'AVAILABLE' },
      });
      const result = await getDataSource({ region: 'us-west-2', knowledgeBaseId: 'KB1', dataSourceId: 'DS1' });
      expect(result?.dataSourceId).toBe('DS1');
    });

    it('returns null when DS not found', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
      const result = await getDataSource({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'MISSING',
      });
      expect(result).toBeNull();
    });
  });

  describe('listIngestionJobs', () => {
    it('returns the list', async () => {
      mockSend.mockResolvedValueOnce({
        ingestionJobSummaries: [{ ingestionJobId: 'IJ1', status: 'COMPLETE', startedAt: new Date('2026-05-01') }],
      });
      const result = await listIngestionJobs({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.ingestionJobId).toBe('IJ1');
    });

    it('returns empty array when none', async () => {
      mockSend.mockResolvedValueOnce({ ingestionJobSummaries: [] });
      const result = await listIngestionJobs({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result).toEqual([]);
    });

    it('paginates through every page until nextToken is undefined', async () => {
      mockSend.mockResolvedValueOnce({
        ingestionJobSummaries: [{ ingestionJobId: 'IJ1', status: 'COMPLETE', startedAt: new Date('2026-05-01') }],
        nextToken: 'page2',
      });
      mockSend.mockResolvedValueOnce({
        ingestionJobSummaries: [{ ingestionJobId: 'IJ2', status: 'COMPLETE', startedAt: new Date('2026-05-02') }],
        nextToken: 'page3',
      });
      mockSend.mockResolvedValueOnce({
        ingestionJobSummaries: [{ ingestionJobId: 'IJ3', status: 'IN_PROGRESS', startedAt: new Date('2026-05-03') }],
        // no nextToken — last page
      });

      const result = await listIngestionJobs({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });

      expect(result).toHaveLength(3);
      expect(result.map(s => s.ingestionJobId)).toEqual(['IJ1', 'IJ2', 'IJ3']);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('returns empty array on ResourceNotFoundException', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
      const result = await listIngestionJobs({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result).toEqual([]);
    });
  });

  describe('listDataSources', () => {
    it('returns the data source summaries', async () => {
      mockSend.mockResolvedValueOnce({
        dataSourceSummaries: [
          { dataSourceId: 'DS1', name: 'a', status: 'AVAILABLE' },
          { dataSourceId: 'DS2', name: 'b', status: 'AVAILABLE' },
        ],
      });
      const result = await listDataSources({ region: 'us-west-2', knowledgeBaseId: 'KB1' });
      expect(result).toHaveLength(2);
      expect(result[0]?.dataSourceId).toBe('DS1');
    });

    it('returns empty array when KB has no DSes', async () => {
      mockSend.mockResolvedValueOnce({ dataSourceSummaries: [] });
      const result = await listDataSources({ region: 'us-west-2', knowledgeBaseId: 'KB1' });
      expect(result).toEqual([]);
    });

    it('returns empty array on ResourceNotFoundException', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
      const result = await listDataSources({ region: 'us-west-2', knowledgeBaseId: 'KB-MISSING' });
      expect(result).toEqual([]);
    });

    it('paginates through every page until nextToken is undefined', async () => {
      mockSend.mockResolvedValueOnce({
        dataSourceSummaries: [{ dataSourceId: 'DS1', name: 'a', status: 'AVAILABLE' }],
        nextToken: 'page2',
      });
      mockSend.mockResolvedValueOnce({
        dataSourceSummaries: [{ dataSourceId: 'DS2', name: 'b', status: 'AVAILABLE' }],
        nextToken: 'page3',
      });
      mockSend.mockResolvedValueOnce({
        dataSourceSummaries: [{ dataSourceId: 'DS3', name: 'c', status: 'AVAILABLE' }],
      });

      const result = await listDataSources({ region: 'us-west-2', knowledgeBaseId: 'KB1' });

      expect(result.map(s => s.dataSourceId)).toEqual(['DS1', 'DS2', 'DS3']);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('startIngestionJob', () => {
    it('returns the ingestion job on success', async () => {
      mockSend.mockResolvedValueOnce({
        ingestionJob: { ingestionJobId: 'IJ-NEW', status: 'STARTING' },
      });
      const result = await startIngestionJob({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result.ingestionJobId).toBe('IJ-NEW');
      expect(result.status).toBe('STARTING');
    });

    it('throws when KB not found', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
      await expect(
        startIngestionJob({ region: 'us-west-2', knowledgeBaseId: 'KB-MISSING', dataSourceId: 'DS1' })
      ).rejects.toThrow();
    });

    it('throws on validation errors verbatim', async () => {
      mockSend.mockRejectedValueOnce(new Error('No documents to ingest'));
      await expect(
        startIngestionJob({ region: 'us-west-2', knowledgeBaseId: 'KB1', dataSourceId: 'DS1' })
      ).rejects.toThrow('No documents to ingest');
    });

    it('throws when response has no ingestionJob', async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(
        startIngestionJob({ region: 'us-west-2', knowledgeBaseId: 'KB1', dataSourceId: 'DS1' })
      ).rejects.toThrow(/no ingestion job/i);
    });
  });

  describe('getLatestIngestionJob', () => {
    it('returns the most recently started job', async () => {
      mockSend.mockResolvedValueOnce({
        ingestionJobSummaries: [
          { ingestionJobId: 'old', status: 'COMPLETE', startedAt: new Date('2026-01-01') },
          { ingestionJobId: 'new', status: 'IN_PROGRESS', startedAt: new Date('2026-05-01') },
        ],
      });
      mockSend.mockResolvedValueOnce({
        ingestionJob: {
          ingestionJobId: 'new',
          status: 'IN_PROGRESS',
          statistics: { numberOfDocumentsScanned: 10 },
        },
      });
      const result = await getLatestIngestionJob({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result?.ingestionJobId).toBe('new');
    });

    it('returns null when no jobs', async () => {
      mockSend.mockResolvedValueOnce({ ingestionJobSummaries: [] });
      const result = await getLatestIngestionJob({
        region: 'us-west-2',
        knowledgeBaseId: 'KB1',
        dataSourceId: 'DS1',
      });
      expect(result).toBeNull();
    });
  });
});
