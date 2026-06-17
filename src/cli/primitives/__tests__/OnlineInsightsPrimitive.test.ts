import { validateInsightIds } from '../OnlineInsightsPrimitive.js';
import { describe, expect, it } from 'vitest';

describe('validateInsightIds', () => {
  it('accepts Builtin.Insight.* identifiers', () => {
    expect(() => validateInsightIds(['Builtin.Insight.FailureAnalysis'])).not.toThrow();
  });

  it('accepts multiple valid identifiers', () => {
    expect(() => validateInsightIds(['Builtin.Insight.FailureAnalysis', 'Builtin.Insight.UserIntent'])).not.toThrow();
  });

  it('accepts full ARN identifiers', () => {
    expect(() =>
      validateInsightIds(['arn:aws:bedrock-agentcore:us-east-1::evaluator/Builtin.Insight.FailureAnalysis'])
    ).not.toThrow();
  });

  it('rejects identifiers without Builtin.Insight.* prefix or ARN', () => {
    expect(() => validateInsightIds(['InvalidString'])).toThrow('Must be a Builtin.Insight.* identifier');
  });

  it('rejects Builtin.Helpfulness (evaluator prefix, not insight)', () => {
    expect(() => validateInsightIds(['Builtin.Helpfulness'])).toThrow('Must be a Builtin.Insight.* identifier');
  });

  it('rejects empty string', () => {
    expect(() => validateInsightIds([''])).toThrow('Must be a Builtin.Insight.* identifier');
  });

  it('rejects when any item in the array is invalid', () => {
    expect(() => validateInsightIds(['Builtin.Insight.FailureAnalysis', 'bad'])).toThrow(
      'Must be a Builtin.Insight.* identifier'
    );
  });
});
