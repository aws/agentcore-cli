import {
  ABTestDescriptionSchema,
  ABTestNameSchema,
  ABTestSchema,
  VariantNameSchema,
  VariantWeightSchema,
} from '../ab-test';
import { describe, expect, it } from 'vitest';

describe('ABTestNameSchema', () => {
  it('accepts valid name starting with letter', () => {
    expect(ABTestNameSchema.safeParse('MyTest_1').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(ABTestNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with number', () => {
    expect(ABTestNameSchema.safeParse('1test').success).toBe(false);
  });

  it('rejects name with hyphens', () => {
    expect(ABTestNameSchema.safeParse('my-test').success).toBe(false);
  });

  it('rejects name over 48 chars', () => {
    expect(ABTestNameSchema.safeParse('a'.repeat(49)).success).toBe(false);
  });

  it('accepts name at 48 chars', () => {
    expect(ABTestNameSchema.safeParse('a'.repeat(48)).success).toBe(true);
  });
});

describe('ABTestDescriptionSchema', () => {
  it('accepts undefined (optional)', () => {
    expect(ABTestDescriptionSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(ABTestDescriptionSchema.safeParse('').success).toBe(false);
  });

  it('rejects string over 200 chars', () => {
    expect(ABTestDescriptionSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('accepts string at exactly 200 chars', () => {
    expect(ABTestDescriptionSchema.safeParse('x'.repeat(200)).success).toBe(true);
  });
});

describe('VariantNameSchema', () => {
  it('accepts C', () => {
    expect(VariantNameSchema.safeParse('C').success).toBe(true);
  });

  it('accepts T1', () => {
    expect(VariantNameSchema.safeParse('T1').success).toBe(true);
  });

  it('rejects other names', () => {
    expect(VariantNameSchema.safeParse('T2').success).toBe(false);
  });
});

describe('VariantWeightSchema', () => {
  it('accepts 1', () => {
    expect(VariantWeightSchema.safeParse(1).success).toBe(true);
  });

  it('accepts 100', () => {
    expect(VariantWeightSchema.safeParse(100).success).toBe(true);
  });

  it('rejects 0', () => {
    expect(VariantWeightSchema.safeParse(0).success).toBe(false);
  });

  it('rejects 101', () => {
    expect(VariantWeightSchema.safeParse(101).success).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(VariantWeightSchema.safeParse(50.5).success).toBe(false);
  });
});

describe('ABTestSchema', () => {
  const validABTest = {
    name: 'TestOne',
    gatewayRef: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-123',
    variants: [
      {
        name: 'C',
        weight: 80,
        variantConfiguration: {
          configurationBundle: { bundleArn: 'arn:bundle:control', bundleVersion: 'v1' },
        },
      },
      {
        name: 'T1',
        weight: 20,
        variantConfiguration: {
          configurationBundle: { bundleArn: 'arn:bundle:treatment', bundleVersion: 'v1' },
        },
      },
    ],
    evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval:config' },
  };

  it('accepts valid minimal AB test', () => {
    expect(ABTestSchema.safeParse(validABTest).success).toBe(true);
  });

  it('accepts with optional fields', () => {
    const result = ABTestSchema.safeParse({
      ...validABTest,
      description: 'A test',
      roleArn: 'arn:aws:iam::123:role/MyRole',
      maxDurationDays: 30,
      enableOnCreate: true,
      trafficAllocationConfig: { routeOnHeader: { headerName: 'X-AB-Route' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects with only 1 variant', () => {
    const result = ABTestSchema.safeParse({
      ...validABTest,
      variants: [validABTest.variants[0]],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with 3 variants', () => {
    const result = ABTestSchema.safeParse({
      ...validABTest,
      variants: [...validABTest.variants, validABTest.variants[0]],
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxDurationDays outside 1-90', () => {
    expect(ABTestSchema.safeParse({ ...validABTest, maxDurationDays: 0 }).success).toBe(false);
    expect(ABTestSchema.safeParse({ ...validABTest, maxDurationDays: 91 }).success).toBe(false);
  });

  describe('variant weight sum validation', () => {
    it('accepts weights summing to 100 (50/50)', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], weight: 50 },
          { ...validABTest.variants[1], weight: 50 },
        ],
      };
      expect(ABTestSchema.safeParse(test).success).toBe(true);
    });

    it('accepts weights summing to 100 (1/99)', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], weight: 1 },
          { ...validABTest.variants[1], weight: 99 },
        ],
      };
      expect(ABTestSchema.safeParse(test).success).toBe(true);
    });

    it('rejects weights summing to 150', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], weight: 80 },
          { ...validABTest.variants[1], weight: 70 },
        ],
      };
      const result = ABTestSchema.safeParse(test);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('sum to 100'))).toBe(true);
      }
    });

    it('rejects weights summing to 2', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], weight: 1 },
          { ...validABTest.variants[1], weight: 1 },
        ],
      };
      expect(ABTestSchema.safeParse(test).success).toBe(false);
    });
  });

  describe('variant uniqueness validation', () => {
    it('rejects two control variants', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], name: 'C', weight: 50 },
          { ...validABTest.variants[1], name: 'C', weight: 50 },
        ],
      };
      const result = ABTestSchema.safeParse(test);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('control (C) and one treatment (T1)'))).toBe(true);
      }
    });

    it('rejects two treatment variants', () => {
      const test = {
        ...validABTest,
        variants: [
          { ...validABTest.variants[0], name: 'T1', weight: 50 },
          { ...validABTest.variants[1], name: 'T1', weight: 50 },
        ],
      };
      const result = ABTestSchema.safeParse(test);
      expect(result.success).toBe(false);
    });
  });
});
