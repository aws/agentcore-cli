import { OnlineEvalConfigSchema } from '../primitives/online-eval-config';
import { describe, expect, it } from 'vitest';

describe('OnlineEvalConfigSchema - evaluators and insights', () => {
  const baseConfig = {
    name: 'TestConfig',
    agent: 'MyAgent',
    samplingRate: 10,
  };

  it('accepts config with evaluators only', () => {
    const config = { ...baseConfig, evaluators: ['Builtin.GoalSuccessRate'] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts config with insights only', () => {
    const config = { ...baseConfig, insights: ['FailureAnalyzer'] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects config with neither evaluators nor insights', () => {
    const result = OnlineEvalConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('At least one of evaluators or insights'))).toBe(true);
    }
  });

  it('rejects config with both evaluators and insights (preview)', () => {
    const config = { ...baseConfig, evaluators: ['Builtin.GoalSuccessRate'], insights: ['FailureAnalyzer'] };
    const result = OnlineEvalConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Cannot have both evaluators and insights'))).toBe(true);
    }
  });

  it('accepts clusteringConfig with valid frequencies', () => {
    const config = {
      ...baseConfig,
      insights: ['FailureAnalyzer'],
      clusteringConfig: { frequencies: ['DAILY', 'WEEKLY'] },
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects clusteringConfig with more than 3 frequencies', () => {
    const config = {
      ...baseConfig,
      insights: ['FailureAnalyzer'],
      clusteringConfig: { frequencies: ['DAILY', 'WEEKLY', 'MONTHLY', 'DAILY'] },
    };
    const result = OnlineEvalConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects clusteringConfig without insights', () => {
    const config = {
      ...baseConfig,
      evaluators: ['Builtin.GoalSuccessRate'],
      clusteringConfig: { frequencies: ['DAILY'] },
    };
    const result = OnlineEvalConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('clusteringConfig requires insights'))).toBe(true);
    }
  });
});
