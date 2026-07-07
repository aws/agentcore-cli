import { DatasetPrimitive } from '../DatasetPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockCopyFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
  findConfigRoot: () => '/fake/root',
}));

vi.mock('node:fs/promises', () => ({
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock('../../templates/templateRoot', () => ({
  getTemplatePath: (...segments: string[]) => `/templates/${segments.join('/')}`,
}));

function makeProject(datasets: { name: string; schemaType?: string }[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    datasets: datasets.map(d => ({
      name: d.name,
      schemaType: d.schemaType ?? 'AGENTCORE_EVALUATION_PREDEFINED_V1',
      config: { managed: { location: `datasets/${d.name}.jsonl` } },
    })),
  };
}

const primitive = new DatasetPrimitive();

describe('DatasetPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  describe('add', () => {
    it('adds dataset to spec with description, returns success and scaffolds file', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockCopyFile.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'MyDataset',
        schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
        description: 'A test dataset',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.datasetName).toBe('MyDataset');
        expect(result.location).toBe('agentcore/datasets/MyDataset.jsonl');
      }

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.datasets).toHaveLength(1);
      expect(writtenSpec.datasets[0].name).toBe('MyDataset');
      expect(writtenSpec.datasets[0].description).toBe('A test dataset');
    });

    it('returns error when name already exists', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'Existing' }]));

      const result = await primitive.add({
        name: 'Existing',
        schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('already exists');
      }
    });

    it('adds dataset with kmsKeyArn and persists to spec', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockCopyFile.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'KmsDataset',
        schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
      });

      expect(result.success).toBe(true);

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.datasets[0].kmsKeyArn).toBe(
        'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012'
      );
    });

    it('omits kmsKeyArn from spec when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockCopyFile.mockResolvedValue(undefined);

      await primitive.add({
        name: 'PlainDataset',
        schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
      });

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.datasets[0].kmsKeyArn).toBeUndefined();
      expect('kmsKeyArn' in writtenSpec.datasets[0]).toBe(false);
    });

    it('returns error when readProjectSpec rejects', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('disk failure'));

      const result = await primitive.add({
        name: 'NewDataset',
        schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('disk failure');
      }
    });
  });

  describe('remove', () => {
    it('removes dataset from spec', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'DatasetA' }, { name: 'DatasetB' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('DatasetA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.datasets).toHaveLength(1);
      expect(writtenSpec.datasets[0].name).toBe('DatasetB');
    });

    it('returns error when dataset not found for removal', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('NonExistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('NonExistent');
        expect(result.error.message).toContain('not found');
      }
    });

    it('returns error when readProjectSpec fails during remove', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('io error'));

      const result = await primitive.remove('Whatever');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('io error');
      }
    });
  });

  describe('previewRemove', () => {
    it('returns summary and schema changes', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'DatasetA' }]));

      const preview = await primitive.previewRemove('DatasetA');

      expect(preview.summary[0]).toContain('Removing dataset: DatasetA');
      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      expect((preview.schemaChanges[0]!.after as { datasets: unknown[] }).datasets).toHaveLength(0);
    });

    it('throws when not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      await expect(primitive.previewRemove('Missing')).rejects.toThrow('not found');
    });
  });

  describe('getRemovable', () => {
    it('returns dataset names', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'A' }, { name: 'B' }]));

      const result = await primitive.getRemovable();

      expect(result).toEqual([{ name: 'A' }, { name: 'B' }]);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getRemovable()).toEqual([]);
    });
  });

  describe('getAllNames', () => {
    it('returns names', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'X' }, { name: 'Y' }]));

      const result = await primitive.getAllNames();

      expect(result).toEqual(['X', 'Y']);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getAllNames()).toEqual([]);
    });
  });
});
