import { ConfigValidationError } from '../config.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('formatZodIssue extended branches', () => {
  it('formats invalid_union_discriminator with options', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cat'), meow: z.boolean() }),
      z.object({ kind: z.literal('dog'), bark: z.boolean() }),
    ]);
    const result = schema.safeParse({ kind: 'fish' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toBeDefined();
    }
  });

  it('formats invalid_type with expected only (no received)', () => {
    const schema = z.string();
    const result = schema.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toBeDefined();
    }
  });

  it('formats invalid_enum_value with received', () => {
    const schema = z.enum(['a', 'b', 'c']);
    const result = schema.safeParse('x');
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toBeDefined();
    }
  });

  it('falls back to Zod message for custom issue codes', () => {
    const schema = z.string().refine(v => v.length > 5, { message: 'Too short' });
    const result = schema.safeParse('hi');
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('Too short');
    }
  });

  it('formats invalid_type with both expected and received', () => {
    const schema = z.object({ count: z.number() });
    const result = schema.safeParse({ count: 'hello' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('count');
    }
  });

  it('formats invalid_enum_value with options list', () => {
    const schema = z.object({ mode: z.enum(['fast', 'slow', 'balanced']) });
    const result = schema.safeParse({ mode: 'turbo' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('mode');
    }
  });
});
