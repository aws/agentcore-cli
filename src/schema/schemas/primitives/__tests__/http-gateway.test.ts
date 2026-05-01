import { HttpGatewayNameSchema, HttpGatewaySchema } from '../http-gateway';
import { describe, expect, it } from 'vitest';

describe('HttpGatewayNameSchema', () => {
  it('accepts valid name starting with letter', () => {
    expect(HttpGatewayNameSchema.safeParse('MyGateway1').success).toBe(true);
  });

  it('accepts name with hyphens', () => {
    expect(HttpGatewayNameSchema.safeParse('my-gateway').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(HttpGatewayNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with number', () => {
    expect(HttpGatewayNameSchema.safeParse('1gateway').success).toBe(false);
  });

  it('rejects name with underscores', () => {
    expect(HttpGatewayNameSchema.safeParse('my_gateway').success).toBe(false);
  });

  it('rejects name over 48 chars', () => {
    expect(HttpGatewayNameSchema.safeParse('a'.repeat(49)).success).toBe(false);
  });

  it('accepts name at 48 chars', () => {
    expect(HttpGatewayNameSchema.safeParse('a'.repeat(48)).success).toBe(true);
  });
});

describe('HttpGatewaySchema', () => {
  const validHttpGateway = {
    name: 'MyGateway',
    runtimeRef: 'my-runtime',
  };

  it('accepts valid HTTP gateway with required fields', () => {
    expect(HttpGatewaySchema.safeParse(validHttpGateway).success).toBe(true);
  });

  it('accepts valid HTTP gateway with all optional fields', () => {
    const result = HttpGatewaySchema.safeParse({
      ...validHttpGateway,
      description: 'A test gateway',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const { name: _, ...withoutName } = validHttpGateway;
    expect(HttpGatewaySchema.safeParse(withoutName).success).toBe(false);
  });

  it('rejects missing runtimeRef', () => {
    const { runtimeRef: _, ...withoutRuntimeRef } = validHttpGateway;
    expect(HttpGatewaySchema.safeParse(withoutRuntimeRef).success).toBe(false);
  });

  it('rejects name too long (>48 chars)', () => {
    expect(HttpGatewaySchema.safeParse({ ...validHttpGateway, name: 'a'.repeat(49) }).success).toBe(false);
  });

  it('rejects name starting with number', () => {
    expect(HttpGatewaySchema.safeParse({ ...validHttpGateway, name: '1Gateway' }).success).toBe(false);
  });

  it('rejects name with invalid characters (underscores)', () => {
    expect(HttpGatewaySchema.safeParse({ ...validHttpGateway, name: 'my_gateway' }).success).toBe(false);
  });

  it('rejects extra unknown fields (.strict())', () => {
    const result = HttpGatewaySchema.safeParse({
      ...validHttpGateway,
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });
});
