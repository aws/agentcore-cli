import { AgentCoreProjectSpecSchema } from '../agentcore-project.js';
import { TagKeySchema, TagValueSchema, TagsSchema } from '../primitives/tags.js';
import { describe, expect, it } from 'vitest';

describe('TagKeySchema', () => {
  it('accepts valid keys', () => {
    expect(TagKeySchema.parse('environment')).toBe('environment');
    expect(TagKeySchema.parse('agentcore:created-by')).toBe('agentcore:created-by');
    expect(TagKeySchema.parse('a'.repeat(128))).toHaveLength(128);
    expect(TagKeySchema.parse('cost-center_v2')).toBe('cost-center_v2');
  });

  it('rejects empty string', () => {
    expect(() => TagKeySchema.parse('')).toThrow();
  });

  it('rejects keys longer than 128 characters', () => {
    expect(() => TagKeySchema.parse('a'.repeat(129))).toThrow();
  });

  it('rejects whitespace-only keys', () => {
    expect(() => TagKeySchema.parse(' ')).toThrow();
    expect(() => TagKeySchema.parse('  \t  ')).toThrow();
  });

  it('rejects aws: prefixed keys', () => {
    expect(() => TagKeySchema.parse('aws:internal')).toThrow();
  });

  it('rejects keys with invalid characters', () => {
    expect(() => TagKeySchema.parse('key\x00null')).toThrow();
    expect(() => TagKeySchema.parse('key{bracket}')).toThrow();
  });
});

describe('TagValueSchema', () => {
  it('accepts valid values', () => {
    expect(TagValueSchema.parse('prod')).toBe('prod');
    expect(TagValueSchema.parse('')).toBe('');
    expect(TagValueSchema.parse('a'.repeat(256))).toHaveLength(256);
  });

  it('rejects values longer than 256 characters', () => {
    expect(() => TagValueSchema.parse('a'.repeat(257))).toThrow();
  });

  it('rejects values with invalid characters', () => {
    expect(() => TagValueSchema.parse('val\x00ue')).toThrow();
  });
});

describe('TagsSchema', () => {
  it('accepts valid tags', () => {
    const result = TagsSchema.parse({ environment: 'prod', team: 'platform' });
    expect(result).toEqual({ environment: 'prod', team: 'platform' });
  });

  it('accepts undefined (optional)', () => {
    expect(TagsSchema.parse(undefined)).toBeUndefined();
  });

  it('accepts empty object', () => {
    expect(TagsSchema.parse({})).toEqual({});
  });

  it('rejects more than 50 tags', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 51; i++) tags[`key${i}`] = `value${i}`;
    expect(() => TagsSchema.parse(tags)).toThrow();
  });

  it('accepts 50 tags', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 50; i++) tags[`key${i}`] = `value${i}`;
    expect(TagsSchema.parse(tags)).toEqual(tags);
  });
});

describe('AgentCoreProjectSpecSchema with tags', () => {
  const validSpec = {
    name: 'TestProject',
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };

  it('accepts spec with project-level tags', () => {
    const result = AgentCoreProjectSpecSchema.parse({
      ...validSpec,
      tags: { 'agentcore:created-by': 'agentcore-cli', environment: 'dev' },
    });
    expect(result.tags).toEqual({ 'agentcore:created-by': 'agentcore-cli', environment: 'dev' });
  });

  it('accepts spec without tags (backwards compatibility)', () => {
    const result = AgentCoreProjectSpecSchema.parse(validSpec);
    expect(result.tags).toBeUndefined();
  });

  it('accepts spec with per-memory tags', () => {
    const result = AgentCoreProjectSpecSchema.parse({
      ...validSpec,
      memories: [
        {
          type: 'AgentCoreMemory',
          name: 'myMemory',
          eventExpiryDuration: 30,
          strategies: [],
          tags: { 'cost-center': '12345' },
        },
      ],
    });
    expect(result.memories[0]!.tags).toEqual({ 'cost-center': '12345' });
  });
});
