import {
  FILTER_OPERATORS,
  FilterRuleSchema,
  FilterValueSchema,
  OnlineEvalConfigNameSchema,
  OnlineEvalConfigSchema,
} from '../online-eval-config';
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

  it('accepts sessionTimeoutMinutes within bounds', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...validConfig, sessionTimeoutMinutes: 1 }).success).toBe(true);
    expect(OnlineEvalConfigSchema.safeParse({ ...validConfig, sessionTimeoutMinutes: 1440 }).success).toBe(true);
  });

  it('rejects sessionTimeoutMinutes out of bounds', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...validConfig, sessionTimeoutMinutes: 0 }).success).toBe(false);
    expect(OnlineEvalConfigSchema.safeParse({ ...validConfig, sessionTimeoutMinutes: 1441 }).success).toBe(false);
  });

  it('rejects non-integer sessionTimeoutMinutes', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...validConfig, sessionTimeoutMinutes: 5.5 }).success).toBe(false);
  });

  it('accepts a config with filters of each value variant', () => {
    const result = OnlineEvalConfigSchema.safeParse({
      ...validConfig,
      filters: [
        { key: 'userId', operator: 'Equals', value: { stringValue: 'abc' } },
        { key: 'score', operator: 'GreaterThan', value: { doubleValue: 0.5 } },
        { key: 'isPremium', operator: 'Equals', value: { booleanValue: true } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects filters with multiple value variants', () => {
    const result = OnlineEvalConfigSchema.safeParse({
      ...validConfig,
      filters: [{ key: 'k', operator: 'Equals', value: { stringValue: 'a', doubleValue: 1 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe('FilterValueSchema', () => {
  it('rejects empty value', () => {
    expect(FilterValueSchema.safeParse({}).success).toBe(false);
  });

  it('accepts each variant alone', () => {
    expect(FilterValueSchema.safeParse({ stringValue: 'x' }).success).toBe(true);
    expect(FilterValueSchema.safeParse({ doubleValue: 1.2 }).success).toBe(true);
    expect(FilterValueSchema.safeParse({ booleanValue: false }).success).toBe(true);
  });
});

describe('FilterRuleSchema', () => {
  it('accepts each documented operator', () => {
    for (const op of FILTER_OPERATORS) {
      const result = FilterRuleSchema.safeParse({
        key: 'userId',
        operator: op,
        value: { stringValue: 'abc' },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown operator', () => {
    expect(
      FilterRuleSchema.safeParse({
        key: 'userId',
        operator: 'StartsWith',
        value: { stringValue: 'abc' },
      }).success
    ).toBe(false);
  });

  it('rejects empty key', () => {
    expect(
      FilterRuleSchema.safeParse({
        key: '',
        operator: 'Equals',
        value: { stringValue: 'abc' },
      }).success
    ).toBe(false);
  });
});
