import {
  OnlineEvalConfigNameSchema,
  OnlineEvalConfigSchema,
  OnlineEvalFilterOperatorSchema,
  OnlineEvalFilterSchema,
  OnlineEvalFilterValueSchema,
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
});

describe('OnlineEvalConfigSchema sessionTimeoutMinutes', () => {
  const base = {
    name: 'TestConfig',
    agent: 'MyAgent',
    evaluators: ['Builtin.GoalSuccessRate'],
    samplingRate: 10,
  };

  it('accepts the lower bound (1)', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: 1 }).success).toBe(true);
  });

  it('accepts the upper bound (1440)', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: 1440 }).success).toBe(true);
  });

  it('rejects 0', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: 0 }).success).toBe(false);
  });

  it('rejects 1441', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: 1441 }).success).toBe(false);
  });

  it('rejects fractional values', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: 5.5 }).success).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(OnlineEvalConfigSchema.safeParse({ ...base, sessionTimeoutMinutes: '5' }).success).toBe(false);
  });

  it('accepts when omitted', () => {
    expect(OnlineEvalConfigSchema.safeParse(base).success).toBe(true);
  });
});

describe('OnlineEvalFilterOperatorSchema', () => {
  const valid = [
    'Equals',
    'NotEquals',
    'GreaterThan',
    'LessThan',
    'GreaterThanOrEqual',
    'LessThanOrEqual',
    'Contains',
    'NotContains',
  ];

  it.each(valid)('accepts %s', op => {
    expect(OnlineEvalFilterOperatorSchema.safeParse(op).success).toBe(true);
  });

  it('rejects unknown PascalCase value', () => {
    expect(OnlineEvalFilterOperatorSchema.safeParse('In').success).toBe(false);
  });

  it('rejects upper-case (e.g. "EQUALS")', () => {
    expect(OnlineEvalFilterOperatorSchema.safeParse('EQUALS').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(OnlineEvalFilterOperatorSchema.safeParse('').success).toBe(false);
  });
});

describe('OnlineEvalFilterValueSchema (exactly-one-of refine)', () => {
  it('rejects empty value object (zero branches set)', () => {
    expect(OnlineEvalFilterValueSchema.safeParse({}).success).toBe(false);
  });

  it('accepts only stringValue', () => {
    expect(OnlineEvalFilterValueSchema.safeParse({ stringValue: 'x' }).success).toBe(true);
  });

  it('accepts only doubleValue', () => {
    expect(OnlineEvalFilterValueSchema.safeParse({ doubleValue: 1.5 }).success).toBe(true);
  });

  it('accepts only booleanValue', () => {
    expect(OnlineEvalFilterValueSchema.safeParse({ booleanValue: false }).success).toBe(true);
  });

  it('rejects two branches set', () => {
    expect(OnlineEvalFilterValueSchema.safeParse({ stringValue: 'x', doubleValue: 1 }).success).toBe(false);
  });

  it('rejects three branches set', () => {
    expect(
      OnlineEvalFilterValueSchema.safeParse({ stringValue: 'x', doubleValue: 1, booleanValue: true }).success
    ).toBe(false);
  });
});

describe('OnlineEvalFilterSchema', () => {
  const validValue = { stringValue: 'abc' };

  it('accepts a well-formed filter', () => {
    expect(OnlineEvalFilterSchema.safeParse({ key: 'user.id', operator: 'Equals', value: validValue }).success).toBe(
      true
    );
  });

  it('rejects an empty key', () => {
    expect(OnlineEvalFilterSchema.safeParse({ key: '', operator: 'Equals', value: validValue }).success).toBe(false);
  });

  it('rejects an unknown operator', () => {
    expect(OnlineEvalFilterSchema.safeParse({ key: 'k', operator: 'EQUALS', value: validValue }).success).toBe(false);
  });

  it('rejects when value is missing', () => {
    expect(OnlineEvalFilterSchema.safeParse({ key: 'k', operator: 'Equals' }).success).toBe(false);
  });
});

describe('OnlineEvalConfigSchema with filters', () => {
  const base = {
    name: 'TestConfig',
    agent: 'MyAgent',
    evaluators: ['Builtin.GoalSuccessRate'],
    samplingRate: 10,
  };

  it('accepts a config with valid filters', () => {
    const result = OnlineEvalConfigSchema.safeParse({
      ...base,
      filters: [{ key: 'user.id', operator: 'Equals', value: { stringValue: 'x' } }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config whose filter value has multiple branches', () => {
    const result = OnlineEvalConfigSchema.safeParse({
      ...base,
      filters: [{ key: 'user.id', operator: 'Equals', value: { stringValue: 'x', doubleValue: 1 } }],
    });
    expect(result.success).toBe(false);
  });
});
