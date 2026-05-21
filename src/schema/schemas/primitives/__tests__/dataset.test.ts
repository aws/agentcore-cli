import { DatasetNameSchema, DatasetSchema } from '../dataset';
import { describe, expect, it } from 'vitest';

describe('DatasetNameSchema', () => {
  describe('valid names', () => {
    it('accepts a simple alphabetic name', () => {
      expect(DatasetNameSchema.safeParse('MyDataset').success).toBe(true);
    });

    it('accepts a name with alphanumeric characters', () => {
      expect(DatasetNameSchema.safeParse('Dataset123').success).toBe(true);
    });

    it('accepts a name with underscores', () => {
      expect(DatasetNameSchema.safeParse('my_dataset').success).toBe(true);
    });

    it('accepts a name at max length (48 chars)', () => {
      const name = 'A' + 'a'.repeat(47);
      expect(DatasetNameSchema.safeParse(name).success).toBe(true);
    });
  });

  describe('invalid names', () => {
    it('rejects an empty string', () => {
      expect(DatasetNameSchema.safeParse('').success).toBe(false);
    });

    it('rejects a name starting with a digit', () => {
      expect(DatasetNameSchema.safeParse('1dataset').success).toBe(false);
    });

    it('rejects a name starting with an underscore', () => {
      expect(DatasetNameSchema.safeParse('_dataset').success).toBe(false);
    });

    it('rejects a name with hyphens', () => {
      expect(DatasetNameSchema.safeParse('my-dataset').success).toBe(false);
    });

    it('rejects a name exceeding 48 characters', () => {
      const name = 'A' + 'a'.repeat(48);
      expect(DatasetNameSchema.safeParse(name).success).toBe(false);
    });
  });
});

describe('DatasetSchema', () => {
  const validDataset = {
    name: 'MyDataset',
    schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
    config: { managed: { location: 'datasets/MyDataset.jsonl' } },
  };

  it('validates a complete dataset', () => {
    const result = DatasetSchema.safeParse(validDataset);
    expect(result.success).toBe(true);
  });

  it('validates a dataset with description', () => {
    const result = DatasetSchema.safeParse({ ...validDataset, description: 'A test dataset' });
    expect(result.success).toBe(true);
  });

  it('validates SIMULATED_V1 schema type', () => {
    const result = DatasetSchema.safeParse({
      ...validDataset,
      schemaType: 'AGENTCORE_EVALUATION_SIMULATED_V1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a dataset without a name', () => {
    const { name: _, ...noName } = validDataset;
    const result = DatasetSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it('rejects a dataset with an invalid name', () => {
    const result = DatasetSchema.safeParse({ ...validDataset, name: '1invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects a dataset without schemaType', () => {
    const { schemaType: _, ...noSchema } = validDataset;
    const result = DatasetSchema.safeParse(noSchema);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid schemaType', () => {
    const result = DatasetSchema.safeParse({ ...validDataset, schemaType: 'INVALID_TYPE' });
    expect(result.success).toBe(false);
  });

  it('rejects a dataset without config', () => {
    const { config: _, ...noConfig } = validDataset;
    const result = DatasetSchema.safeParse(noConfig);
    expect(result.success).toBe(false);
  });

  it('rejects a dataset with empty managed location', () => {
    const result = DatasetSchema.safeParse({
      ...validDataset,
      config: { managed: { location: '' } },
    });
    expect(result.success).toBe(false);
  });
});
