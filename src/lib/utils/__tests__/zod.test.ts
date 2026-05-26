import { resilientParse, validateAgentSchema, validateProjectSchema } from '../zod.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('validateAgentSchema', () => {
  const validAgent = {
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
    protocol: 'HTTP',
  };

  it('returns validated data for valid input', () => {
    const result = validateAgentSchema(validAgent);
    expect(result.name).toBe('TestAgent');
    expect(result.build).toBe('CodeZip');
  });

  it('throws for invalid input', () => {
    expect(() => validateAgentSchema({})).toThrow('Invalid AgentEnvSpec');
  });

  it('includes field-level errors in message', () => {
    try {
      validateAgentSchema({ type: 'Invalid' });
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('Invalid AgentEnvSpec');
    }
  });

  it('throws for null input', () => {
    expect(() => validateAgentSchema(null)).toThrow();
  });
});

describe('validateProjectSchema', () => {
  const validProject = {
    name: 'TestProject',
    version: 1,
    runtimes: [],
    memories: [],
    credentials: [],
  };

  it('returns validated data for valid input', () => {
    const result = validateProjectSchema(validProject);
    expect(result.name).toBe('TestProject');
    expect(result.version).toBe(1);
  });

  it('applies defaults for missing optional arrays', () => {
    const result = validateProjectSchema({ name: 'MyProject', version: 1 });
    expect(result.runtimes).toEqual([]);
    expect(result.memories).toEqual([]);
    expect(result.credentials).toEqual([]);
  });

  it('throws for invalid input', () => {
    expect(() => validateProjectSchema({})).toThrow('Invalid AgentCoreProjectSpec');
  });

  it('throws for duplicate agent names', () => {
    const agent = {
      name: 'Same',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: '.',
      runtimeVersion: 'PYTHON_3_12',
      protocol: 'HTTP',
    };
    expect(() =>
      validateProjectSchema({
        name: 'MyProject',
        version: 1,
        runtimes: [agent, agent],
      })
    ).toThrow('Invalid AgentCoreProjectSpec');
  });
});

describe('resilientParse', () => {
  it('passes valid fields through unchanged', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = resilientParse(schema, { name: 'valid', age: 42 });
    expect(result.name).toBe('valid');
    expect(result.age).toBe(42);
  });

  it('defaults invalid fields to undefined', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = resilientParse(schema, { name: 'valid', age: 'not a number' });
    expect(result.name).toBe('valid');
    expect(result.age).toBeUndefined();
  });

  it('recursively parses nested objects', () => {
    const schema = z.object({
      settings: z.object({
        enabled: z.boolean(),
        name: z.string(),
      }),
    });
    const result = resilientParse(schema, { settings: { enabled: 'bad', name: 'good' } });
    expect(result.settings).toEqual({ name: 'good' });
  });

  it('skips keys not present in data', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = resilientParse(schema, { name: 'valid' });
    expect(result).toEqual({ name: 'valid' });
    expect('age' in result).toBe(false);
  });

  it('preserves unknown keys', () => {
    const schema = z.object({ known: z.string() });
    const result = resilientParse(schema, { known: 'hello', extra: 'world' });
    expect(result.known).toBe('hello');
    expect((result as Record<string, unknown>).extra).toBe('world');
  });

  it('recursively parses nested objects wrapped in ZodOptional', () => {
    const schema = z.object({
      settings: z
        .object({
          enabled: z.boolean(),
          name: z.string(),
        })
        .optional(),
    });
    const result = resilientParse(schema, { settings: { enabled: 'bad', name: 'good' } });
    expect(result.settings).toEqual({ name: 'good' });
  });

  it('supports custom fallback value', () => {
    const schema = z.object({ name: z.string() });
    const result = resilientParse(schema, { name: 123 }, { fallback: 'unknown' });
    expect(result.name).toBe('unknown');
  });
});
