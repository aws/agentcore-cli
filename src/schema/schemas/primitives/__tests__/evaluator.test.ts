import {
  CategoricalRatingSchema,
  EvaluationLevelSchema,
  EvaluatorConfigSchema,
  EvaluatorNameSchema,
  NumericalRatingSchema,
  RatingScaleSchema,
} from '../evaluator';
import { describe, expect, it } from 'vitest';

describe('EvaluationLevelSchema', () => {
  it('accepts valid levels and rejects invalid', () => {
    expect(EvaluationLevelSchema.safeParse('SESSION').success).toBe(true);
    expect(EvaluationLevelSchema.safeParse('TOOL_CALL').success).toBe(true);
    expect(EvaluationLevelSchema.safeParse('session').success).toBe(false);
    expect(EvaluationLevelSchema.safeParse('INVALID').success).toBe(false);
  });
});

describe('EvaluatorNameSchema', () => {
  it('accepts valid names', () => {
    expect(EvaluatorNameSchema.safeParse('MyEval').success).toBe(true);
    expect(EvaluatorNameSchema.safeParse('eval_1').success).toBe(true);
    expect(EvaluatorNameSchema.safeParse('A').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(EvaluatorNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names starting with a number', () => {
    expect(EvaluatorNameSchema.safeParse('1eval').success).toBe(false);
  });

  it('rejects names starting with underscore', () => {
    expect(EvaluatorNameSchema.safeParse('_eval').success).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(EvaluatorNameSchema.safeParse('my-eval').success).toBe(false);
    expect(EvaluatorNameSchema.safeParse('my eval').success).toBe(false);
    expect(EvaluatorNameSchema.safeParse('my.eval').success).toBe(false);
  });

  it('rejects names longer than 48 characters', () => {
    const longName = 'A' + 'a'.repeat(48);
    expect(longName.length).toBe(49);
    expect(EvaluatorNameSchema.safeParse(longName).success).toBe(false);
  });

  it('accepts names exactly 48 characters', () => {
    const name = 'A' + 'a'.repeat(47);
    expect(name.length).toBe(48);
    expect(EvaluatorNameSchema.safeParse(name).success).toBe(true);
  });
});

describe('NumericalRatingSchema', () => {
  it('accepts valid numerical rating', () => {
    const result = NumericalRatingSchema.safeParse({ value: 1, label: 'Poor', definition: 'Fails expectations' });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer value', () => {
    const result = NumericalRatingSchema.safeParse({ value: 1.5, label: 'Ok', definition: 'Decent' });
    expect(result.success).toBe(false);
  });

  it('rejects empty label', () => {
    const result = NumericalRatingSchema.safeParse({ value: 1, label: '', definition: 'Test' });
    expect(result.success).toBe(false);
  });

  it('rejects empty definition', () => {
    const result = NumericalRatingSchema.safeParse({ value: 1, label: 'Test', definition: '' });
    expect(result.success).toBe(false);
  });
});

describe('CategoricalRatingSchema', () => {
  it('accepts valid categorical rating', () => {
    const result = CategoricalRatingSchema.safeParse({ label: 'Pass', definition: 'Meets criteria' });
    expect(result.success).toBe(true);
  });

  it('rejects empty label', () => {
    expect(CategoricalRatingSchema.safeParse({ label: '', definition: 'Test' }).success).toBe(false);
  });
});

describe('RatingScaleSchema', () => {
  it('accepts numerical-only scale', () => {
    const result = RatingScaleSchema.safeParse({
      numerical: [
        { value: 1, label: 'Bad', definition: 'Poor' },
        { value: 2, label: 'Good', definition: 'Nice' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts categorical-only scale', () => {
    const result = RatingScaleSchema.safeParse({
      categorical: [
        { label: 'Pass', definition: 'Good' },
        { label: 'Fail', definition: 'Bad' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects scale with both numerical and categorical', () => {
    const result = RatingScaleSchema.safeParse({
      numerical: [{ value: 1, label: 'Bad', definition: 'Poor' }],
      categorical: [{ label: 'Pass', definition: 'Good' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects scale with neither numerical nor categorical', () => {
    const result = RatingScaleSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('EvaluatorConfigSchema', () => {
  const validConfig = {
    llmAsAJudge: {
      model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      instructions: 'Evaluate the quality. Context: {context}',
      ratingScale: {
        numerical: [
          { value: 1, label: 'Poor', definition: 'Fails' },
          { value: 5, label: 'Excellent', definition: 'Perfect' },
        ],
      },
    },
  };

  it('accepts valid evaluator config', () => {
    expect(EvaluatorConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('rejects missing model', () => {
    const config = { llmAsAJudge: { ...validConfig.llmAsAJudge, model: '' } };
    expect(EvaluatorConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects missing instructions', () => {
    const config = { llmAsAJudge: { ...validConfig.llmAsAJudge, instructions: '' } };
    expect(EvaluatorConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects missing llmAsAJudge key', () => {
    expect(EvaluatorConfigSchema.safeParse({}).success).toBe(false);
  });
});
