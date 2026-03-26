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
    type: 'OnlineEvaluationConfig' as const,
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

  it('rejects wrong type literal', () => {
    const config = { ...validConfig, type: 'WrongType' };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
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
