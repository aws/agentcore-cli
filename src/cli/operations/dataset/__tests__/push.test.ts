import { pushDataset } from '../push.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockGetDataset = vi.fn();
const mockDownloadDataset = vi.fn();
const mockAddDatasetExamples = vi.fn();
const mockUpdateDatasetExamples = vi.fn();
const mockDeleteDatasetExamples = vi.fn();
const mockWaitForDatasetActive = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('../../../aws/agentcore-datasets', () => ({
  getDataset: (...args: unknown[]) => mockGetDataset(...args),
  downloadDataset: (...args: unknown[]) => mockDownloadDataset(...args),
  addDatasetExamples: (...args: unknown[]) => mockAddDatasetExamples(...args),
  updateDatasetExamples: (...args: unknown[]) => mockUpdateDatasetExamples(...args),
  deleteDatasetExamples: (...args: unknown[]) => mockDeleteDatasetExamples(...args),
}));

vi.mock('../wait', () => ({
  waitForDatasetActive: (...args: unknown[]) => mockWaitForDatasetActive(...args),
}));

vi.mock('../../../aws/retry', () => ({
  isRetryableAwsError: (err: unknown) => {
    const e = err as { name?: string; statusCode?: number };
    return e.name === 'ThrottlingException' || e.statusCode === 429 || (e.statusCode ?? 0) >= 500;
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => 'uuid-mock',
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeLocalContent(examples: Record<string, unknown>[]): string {
  return examples.map(e => JSON.stringify(e)).join('\n') + '\n';
}

function makeRemoteContent(examples: Record<string, unknown>[]): string {
  return examples.map(e => JSON.stringify(e)).join('\n') + '\n';
}

const baseOptions = {
  region: 'us-east-1',
  datasetId: 'ds-123',
  localFilePath: 'datasets/test.jsonl',
  configBaseDir: '/project',
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pushDataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWaitForDatasetActive.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('Parsing', () => {
    it('parses valid JSONL with exampleIds into ParsedExample array', async () => {
      const local = makeLocalContent([
        { exampleId: 'e1', input: 'hello' },
        { exampleId: 'e2', input: 'world' },
      ]);
      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({
        downloadUrl: 'https://s3.example.com/data',
        exampleCount: 2,
      });
      mockDownloadDataset.mockResolvedValue(
        makeRemoteContent([
          { exampleId: 'e1', input: 'hello' },
          { exampleId: 'e2', input: 'world' },
        ])
      );

      const result = await pushDataset(baseOptions);

      expect(result.unchanged).toBe(2);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
    });

    it('throws with line number on invalid JSON', async () => {
      const local = '{"valid":"line"}\nnot-json-at-all\n';
      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });

      await expect(pushDataset(baseOptions)).rejects.toThrow('Invalid JSON at line 2');
    });

    it('contentEquals returns true for same content with different key order', async () => {
      const local = makeLocalContent([{ exampleId: 'e1', input: 'hi', output: 'bye' }]);
      // Remote has different key order but same content
      const remote = makeRemoteContent([{ exampleId: 'e1', output: 'bye', input: 'hi' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 1 });
      mockDownloadDataset.mockResolvedValue(remote);

      const result = await pushDataset(baseOptions);

      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('contentEquals returns false for different content', async () => {
      const local = makeLocalContent([{ exampleId: 'e1', input: 'changed' }]);
      const remote = makeRemoteContent([{ exampleId: 'e1', input: 'original' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 1 });
      mockDownloadDataset.mockResolvedValue(remote);
      mockUpdateDatasetExamples.mockResolvedValue({ updatedCount: 1, status: 'ACTIVE' });

      const result = await pushDataset(baseOptions);

      expect(result.updated).toBe(1);
      expect(result.unchanged).toBe(0);
    });
  });

  describe('Incremental Diff', () => {
    it('identifies examples without exampleId as adds', async () => {
      const local = makeLocalContent([{ input: 'new example without id' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });
      mockAddDatasetExamples.mockResolvedValue({ addedCount: 1, exampleIds: ['new-id-1'], status: 'ACTIVE' });

      const result = await pushDataset(baseOptions);

      expect(result.added).toBe(1);
      expect(mockAddDatasetExamples).toHaveBeenCalled();
    });

    it('identifies stale exampleId (not in remote) as adds', async () => {
      const local = makeLocalContent([{ exampleId: 'stale-id', input: 'data' }]);
      const remote = makeRemoteContent([{ exampleId: 'other-id', input: 'other' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 1 });
      mockDownloadDataset.mockResolvedValue(remote);
      mockDeleteDatasetExamples.mockResolvedValue({ deletedCount: 1, status: 'ACTIVE' });
      mockAddDatasetExamples.mockResolvedValue({ addedCount: 1, exampleIds: ['fresh-id'], status: 'ACTIVE' });

      const result = await pushDataset(baseOptions);

      expect(result.added).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it('identifies changed content as updates', async () => {
      const local = makeLocalContent([{ exampleId: 'e1', input: 'updated-content' }]);
      const remote = makeRemoteContent([{ exampleId: 'e1', input: 'old-content' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 1 });
      mockDownloadDataset.mockResolvedValue(remote);
      mockUpdateDatasetExamples.mockResolvedValue({ updatedCount: 1, status: 'ACTIVE' });

      const result = await pushDataset(baseOptions);

      expect(result.updated).toBe(1);
    });

    it('counts unchanged examples correctly', async () => {
      const examples = [
        { exampleId: 'e1', input: 'same1' },
        { exampleId: 'e2', input: 'same2' },
        { exampleId: 'e3', input: 'same3' },
      ];
      const local = makeLocalContent(examples);
      const remote = makeRemoteContent(examples);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 3 });
      mockDownloadDataset.mockResolvedValue(remote);

      const result = await pushDataset(baseOptions);

      expect(result.unchanged).toBe(3);
      expect(mockAddDatasetExamples).not.toHaveBeenCalled();
      expect(mockUpdateDatasetExamples).not.toHaveBeenCalled();
      expect(mockDeleteDatasetExamples).not.toHaveBeenCalled();
    });

    it('identifies remote-only examples as deletes', async () => {
      const local = makeLocalContent([{ exampleId: 'e1', input: 'kept' }]);
      const remote = makeRemoteContent([
        { exampleId: 'e1', input: 'kept' },
        { exampleId: 'e2', input: 'removed' },
      ]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 2 });
      mockDownloadDataset.mockResolvedValue(remote);
      mockDeleteDatasetExamples.mockResolvedValue({ deletedCount: 1, status: 'ACTIVE' });

      const result = await pushDataset(baseOptions);

      expect(result.deleted).toBe(1);
      expect(mockDeleteDatasetExamples).toHaveBeenCalled();
    });

    it('writes back new exampleIds to local file after add', async () => {
      const local = makeLocalContent([{ input: 'new-example' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });
      mockAddDatasetExamples.mockResolvedValue({ addedCount: 1, exampleIds: ['assigned-id-1'], status: 'ACTIVE' });

      await pushDataset(baseOptions);

      expect(mockWriteFile).toHaveBeenCalled();
      const writtenContent = mockWriteFile.mock.calls[0]![1] as string;
      expect(writtenContent).toContain('assigned-id-1');
    });

    it('reordered examples (same IDs + content) results in zero mutations', async () => {
      const local = makeLocalContent([
        { exampleId: 'e2', input: 'second' },
        { exampleId: 'e1', input: 'first' },
      ]);
      const remote = makeRemoteContent([
        { exampleId: 'e1', input: 'first' },
        { exampleId: 'e2', input: 'second' },
      ]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 2 });
      mockDownloadDataset.mockResolvedValue(remote);

      const result = await pushDataset(baseOptions);

      expect(result.unchanged).toBe(2);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });

  describe('Force Mode', () => {
    it('force mode deletes all remote then re-adds all local', async () => {
      const local = makeLocalContent([{ exampleId: 'e1', input: 'data' }]);
      const remote = makeRemoteContent([
        { exampleId: 'r1', input: 'remote1' },
        { exampleId: 'r2', input: 'remote2' },
      ]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: 'https://s3/data', exampleCount: 2 });
      mockDownloadDataset.mockResolvedValue(remote);
      mockDeleteDatasetExamples.mockResolvedValue({ deletedCount: 2, status: 'ACTIVE' });
      mockAddDatasetExamples.mockResolvedValue({ addedCount: 1, exampleIds: ['new-id'], status: 'ACTIVE' });

      const result = await pushDataset({ ...baseOptions, force: true });

      expect(result.deleted).toBe(2);
      expect(result.added).toBe(1);
      expect(mockDeleteDatasetExamples).toHaveBeenCalled();
      expect(mockAddDatasetExamples).toHaveBeenCalled();
    });

    it('force mode writes back all new exampleIds', async () => {
      const local = makeLocalContent([{ exampleId: 'old1', input: 'a' }, { input: 'b' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });
      mockAddDatasetExamples.mockResolvedValue({
        addedCount: 2,
        exampleIds: ['fresh-1', 'fresh-2'],
        status: 'ACTIVE',
      });

      await pushDataset({ ...baseOptions, force: true });

      expect(mockWriteFile).toHaveBeenCalled();
      const writtenContent = mockWriteFile.mock.calls[0]![1] as string;
      expect(writtenContent).toContain('fresh-1');
      expect(writtenContent).toContain('fresh-2');
    });
  });

  describe('Batching and Retry', () => {
    it('batches items into chunks of API_BATCH_LIMIT (1000)', async () => {
      // Create 2001 examples to test batching
      const examples = Array.from({ length: 2001 }, (_, i) => ({ input: `item-${i}` }));
      const local = makeLocalContent(examples);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });

      let callCount = 0;
      mockAddDatasetExamples.mockImplementation(({ examples: batch }: { examples: unknown[] }) => {
        callCount++;
        return Promise.resolve({
          addedCount: batch.length,
          exampleIds: batch.map((_, i) => `id-${callCount}-${i}`),
          status: 'ACTIVE',
        });
      });

      const result = await pushDataset(baseOptions);

      expect(result.added).toBe(2001);
      // Should be 3 batches: 1000, 1000, 1
      expect(mockAddDatasetExamples).toHaveBeenCalledTimes(3);
    });

    it('retries transient errors up to 3 times with backoff', async () => {
      const local = makeLocalContent([{ input: 'data' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });

      let attempts = 0;
      mockAddDatasetExamples.mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Throttled') as Error & { name: string };
          err.name = 'ThrottlingException';
          return Promise.reject(err);
        }
        return Promise.resolve({ addedCount: 1, exampleIds: ['id-1'], status: 'ACTIVE' });
      });

      const result = await pushDataset(baseOptions);

      expect(result.added).toBe(1);
      expect(attempts).toBe(3);
    });

    it('throws immediately on non-retryable client error', async () => {
      const local = makeLocalContent([{ input: 'data' }]);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });
      mockAddDatasetExamples.mockRejectedValue(
        Object.assign(new Error('Validation error'), { name: 'ValidationException', statusCode: 400 })
      );

      await expect(pushDataset(baseOptions)).rejects.toThrow('Push failed during add phase');
    });

    it('throws descriptive error with batch progress on final failure', async () => {
      // Create 2001 examples to guarantee multiple batches
      const examples = Array.from({ length: 2001 }, (_, i) => ({ input: `item-${i}` }));
      const local = makeLocalContent(examples);

      mockReadFile.mockResolvedValue(local);
      mockGetDataset.mockResolvedValue({ downloadUrl: null, exampleCount: 0 });

      let callCount = 0;
      mockAddDatasetExamples.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // Non-retryable error so it fails immediately without retry
          const err = new Error('Validation error') as Error & { name: string; statusCode: number };
          err.name = 'ValidationException';
          err.statusCode = 400;
          return Promise.reject(err);
        }
        return Promise.resolve({
          addedCount: 1000,
          exampleIds: Array.from({ length: 1000 }, (_, i) => `id-${callCount}-${i}`),
          status: 'ACTIVE',
        });
      });

      await expect(pushDataset(baseOptions)).rejects.toThrow(/Push failed during add phase.*1\/3 batches completed/);
    });
  });
});
