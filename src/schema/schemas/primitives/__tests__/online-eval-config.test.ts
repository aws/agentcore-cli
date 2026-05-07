import { OnlineEvalConfigNameSchema, OnlineEvalConfigSchema } from '../online-eval-config';
import { describe, expect, it } from 'vitest';

describe('OnlineEvalConfigNameSchema', () => {
  it('accepts valid names', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('MyConfig').success).toBe(true);
    expect(OnlineEvalConfigNameSchema.safeParse('config_1').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names starting with a number', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('1config').success).toBe(false);
  });

  it('rejects names with hyphens', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('my-config').success).toBe(false);
  });

  it('rejects names longer than 48 characters', () => {
    const longName = 'A' + 'a'.repeat(48);
    expect(OnlineEvalConfigNameSchema.safeParse(longName).success).toBe(false);
  });
});

describe('OnlineEvalConfigSchema', () => {
  const validConfig = {
    name: 'TestConfig',
    agent: 'MyAgent',
    evaluators: ['Builtin.GoalSuccessRate'],
    samplingRate: 10,
  };

  it('accepts valid config', () => {
    expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('accepts multiple evaluators', () => {
    const config = { ...validConfig, evaluators: ['Builtin.X', 'CustomEval'] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts evaluator ARNs', () => {
    const config = {
      ...validConfig,
      evaluators: ['arn:aws:bedrock:us-east-1:123456:evaluator/MyEval-abc'],
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects empty evaluators array', () => {
    const config = { ...validConfig, evaluators: [] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects sampling rate below 0.01', () => {
    const config = { ...validConfig, samplingRate: 0.001 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects sampling rate above 100', () => {
    const config = { ...validConfig, samplingRate: 101 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts minimum sampling rate of 0.01', () => {
    const config = { ...validConfig, samplingRate: 0.01 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts maximum sampling rate of 100', () => {
    const config = { ...validConfig, samplingRate: 100 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects empty string in evaluators array', () => {
    const config = { ...validConfig, evaluators: [''] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts optional description field', () => {
    const config = { ...validConfig, description: 'My eval config description' };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects description longer than 200 characters', () => {
    const config = { ...validConfig, description: 'x'.repeat(201) };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts optional enableOnCreate field', () => {
    const config = { ...validConfig, enableOnCreate: false };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts config without description and enableOnCreate', () => {
    expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  describe('sessionTimeoutMinutes', () => {
    it('accepts boundary value 1', () => {
      const config = { ...validConfig, sessionTimeoutMinutes: 1 };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
    });

    it('accepts boundary value 1440', () => {
      const config = { ...validConfig, sessionTimeoutMinutes: 1440 };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
    });

    it('rejects 0', () => {
      const config = { ...validConfig, sessionTimeoutMinutes: 0 };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects 1441', () => {
      const config = { ...validConfig, sessionTimeoutMinutes: 1441 };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects non-integer values', () => {
      const config = { ...validConfig, sessionTimeoutMinutes: 5.5 };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('omitting the field is valid (uses construct default)', () => {
      expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
    });
  });

  describe('filters', () => {
    const baseFilter = {
      key: 'model',
      operator: 'Equals' as const,
      value: { stringValue: 'claude-3' },
    };

    it('accepts a single valid filter with a stringValue', () => {
      const config = { ...validConfig, filters: [baseFilter] };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
    });

    it('accepts filters with doubleValue and booleanValue', () => {
      const config = {
        ...validConfig,
        filters: [
          { key: 'latencyMs', operator: 'LessThan', value: { doubleValue: 1000 } },
          { key: 'success', operator: 'Equals', value: { booleanValue: true } },
        ],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
    });

    it('accepts every supported operator', () => {
      const operators = [
        'Equals',
        'NotEquals',
        'GreaterThan',
        'LessThan',
        'GreaterThanOrEqual',
        'LessThanOrEqual',
        'Contains',
        'NotContains',
      ] as const;
      for (const op of operators) {
        const config = { ...validConfig, filters: [{ ...baseFilter, operator: op }] };
        expect(OnlineEvalConfigSchema.safeParse(config).success, `operator ${op}`).toBe(true);
      }
    });

    it('rejects an invalid operator', () => {
      const config = {
        ...validConfig,
        filters: [{ ...baseFilter, operator: 'StartsWith' }],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a filter with zero value variants set', () => {
      const config = {
        ...validConfig,
        filters: [{ key: 'model', operator: 'Equals', value: {} }],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a filter with two value variants set simultaneously', () => {
      const config = {
        ...validConfig,
        filters: [
          {
            key: 'model',
            operator: 'Equals',
            value: { stringValue: 'claude-3', doubleValue: 1 },
          },
        ],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a filter with all three value variants set', () => {
      const config = {
        ...validConfig,
        filters: [
          {
            key: 'model',
            operator: 'Equals',
            value: { stringValue: 'x', doubleValue: 1, booleanValue: true },
          },
        ],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a filter with an empty key', () => {
      const config = {
        ...validConfig,
        filters: [{ ...baseFilter, key: '' }],
      };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
    });

    it('omitting the field is valid', () => {
      expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
    });

    it('accepts an empty filters array', () => {
      const config = { ...validConfig, filters: [] };
      expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
    });
  });
});
