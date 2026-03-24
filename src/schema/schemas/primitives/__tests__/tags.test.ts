import { TagKeySchema, TagValueSchema, TagsSchema } from '../tags';
import { describe, expect, it } from 'vitest';

describe('TagKeySchema', () => {
  it('accepts valid tag keys', () => {
    expect(TagKeySchema.safeParse('environment').success).toBe(true);
    expect(TagKeySchema.safeParse('cost-center').success).toBe(true);
    expect(TagKeySchema.safeParse('agentcore:created-by').success).toBe(true);
  });

  it('rejects empty key', () => {
    expect(TagKeySchema.safeParse('').success).toBe(false);
  });

  it('rejects whitespace-only key', () => {
    expect(TagKeySchema.safeParse('   ').success).toBe(false);
  });

  it('rejects key starting with aws:', () => {
    expect(TagKeySchema.safeParse('aws:something').success).toBe(false);
  });

  it('rejects key exceeding 128 characters', () => {
    expect(TagKeySchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects key with invalid characters', () => {
    expect(TagKeySchema.safeParse('key{invalid}').success).toBe(false);
    expect(TagKeySchema.safeParse('key<html>').success).toBe(false);
    expect(TagKeySchema.safeParse('key|pipe').success).toBe(false);
  });
});

describe('TagValueSchema', () => {
  it('accepts valid tag values', () => {
    expect(TagValueSchema.safeParse('production').success).toBe(true);
    expect(TagValueSchema.safeParse('').success).toBe(true);
  });

  it('rejects value exceeding 256 characters', () => {
    expect(TagValueSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });
});

describe('TagsSchema', () => {
  it('accepts valid tags object', () => {
    expect(TagsSchema.safeParse({ env: 'prod', team: 'platform' }).success).toBe(true);
  });

  it('accepts empty object', () => {
    expect(TagsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts undefined via optional', () => {
    expect(TagsSchema.optional().parse(undefined)).toBeUndefined();
  });

  it('rejects more than 50 tags', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 51; i++) {
      tags[`key${i}`] = `value${i}`;
    }
    expect(TagsSchema.safeParse(tags).success).toBe(false);
  });
});
