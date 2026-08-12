import {
  CategoricalRatingSchema,
  EvaluationLevelSchema,
  EvaluatorConfigSchema,
  EvaluatorModelIdSchema,
  EvaluatorNameSchema,
  NumericalRatingSchema,
  RatingScaleSchema,
  isValidKmsKeyArn,
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

  it('accepts an OpenResponses model config', () => {
    const config = {
      llmAsAJudge: {
        ...validConfig.llmAsAJudge,
        modelProvider: 'OpenResponses',
        model: 'openai.gpt-5.4',
      },
    };

    expect(EvaluatorConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects the obsolete OpenAI provider discriminator', () => {
    const config = {
      llmAsAJudge: {
        ...validConfig.llmAsAJudge,
        modelProvider: 'OpenAI',
        model: 'openai.gpt-5.4',
      },
    };

    expect(EvaluatorConfigSchema.safeParse(config).success).toBe(false);
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

describe('EvaluatorModelIdSchema', () => {
  it('accepts Bedrock and OpenResponses model IDs', () => {
    expect(EvaluatorModelIdSchema.safeParse('us.anthropic.claude-sonnet-4-5-20250929-v1:0').success).toBe(true);
    expect(EvaluatorModelIdSchema.safeParse('openai.gpt-5.4').success).toBe(true);
  });

  it('rejects whitespace, control characters, Unicode, and oversized IDs', () => {
    expect(EvaluatorModelIdSchema.safeParse('   ').success).toBe(false);
    expect(EvaluatorModelIdSchema.safeParse('openai.gpt-5.4\nspoofed').success).toBe(false);
    expect(EvaluatorModelIdSchema.safeParse('openai.gpt-5.4\u202e').success).toBe(false);
    expect(EvaluatorModelIdSchema.safeParse('a'.repeat(2049)).success).toBe(false);
  });
});

describe('isValidKmsKeyArn', () => {
  it('accepts valid commercial KMS key ARN', () => {
    expect(isValidKmsKeyArn('arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012')).toBe(true);
  });

  it('accepts valid GovCloud KMS key ARN', () => {
    expect(
      isValidKmsKeyArn('arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/12345678-1234-1234-1234-123456789012')
    ).toBe(true);
  });

  it('accepts valid China partition KMS key ARN', () => {
    expect(isValidKmsKeyArn('arn:aws-cn:kms:cn-north-1:123456789012:key/12345678-1234-1234-1234-123456789012')).toBe(
      true
    );
  });

  it('rejects ARN with wrong service', () => {
    expect(isValidKmsKeyArn('arn:aws:s3:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012')).toBe(false);
  });

  it('rejects ARN with alias instead of key', () => {
    expect(isValidKmsKeyArn('arn:aws:kms:us-east-1:123456789012:alias/my-key')).toBe(false);
  });

  it('rejects ARN with invalid account ID length', () => {
    expect(isValidKmsKeyArn('arn:aws:kms:us-east-1:12345:key/12345678-1234-1234-1234-123456789012')).toBe(false);
  });

  it('rejects ARN with invalid key UUID format', () => {
    expect(isValidKmsKeyArn('arn:aws:kms:us-east-1:123456789012:key/not-a-valid-uuid')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidKmsKeyArn('')).toBe(false);
  });

  it('rejects random string', () => {
    expect(isValidKmsKeyArn('not-an-arn-at-all')).toBe(false);
  });
});
