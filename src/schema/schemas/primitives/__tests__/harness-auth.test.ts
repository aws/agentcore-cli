import { HarnessSpecSchema } from '../harness';
import { describe, expect, it } from 'vitest';

describe('HarnessSpecSchema – auth fields', () => {
  const minimalHarness = {
    name: 'myHarness',
    model: {
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    },
  };

  const validCustomJwtConfig = {
    customJwtAuthorizer: {
      discoveryUrl: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc123/.well-known/openid-configuration',
      allowedAudience: ['my-client-id'],
    },
  };

  it('accepts harness spec with no auth fields (backwards compat)', () => {
    const result = HarnessSpecSchema.safeParse(minimalHarness);
    expect(result.success).toBe(true);
  });

  it('accepts harness spec with authorizerType AWS_IAM only', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerType: 'AWS_IAM',
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness spec with authorizerType CUSTOM_JWT and proper authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: validCustomJwtConfig,
    });
    expect(result.success).toBe(true);
  });

  it('rejects authorizerType CUSTOM_JWT without authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerType: 'CUSTOM_JWT',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(i =>
          i.message.includes(
            'authorizerConfiguration with customJwtAuthorizer is required when authorizerType is CUSTOM_JWT'
          )
        )
      ).toBe(true);
    }
  });

  it('rejects authorizerConfiguration present without authorizerType CUSTOM_JWT', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerConfiguration: validCustomJwtConfig,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(i =>
          i.message.includes('authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT')
        )
      ).toBe(true);
    }
  });

  it('rejects authorizerConfiguration with authorizerType AWS_IAM', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerType: 'AWS_IAM',
      authorizerConfiguration: validCustomJwtConfig,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(i =>
          i.message.includes('authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT')
        )
      ).toBe(true);
    }
  });

  it('rejects invalid authorizerType value', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      authorizerType: 'INVALID_VALUE',
    });
    expect(result.success).toBe(false);
  });
});
