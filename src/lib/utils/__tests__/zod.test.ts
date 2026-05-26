import { validateAgentSchema, validateProjectSchema, withCatchAll } from '../zod.js';
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

describe('withCatchAll', () => {
  it('wraps top-level fields with catch', () => {
    const strict = z.object({ name: z.string(), age: z.number() });
    const lenient = withCatchAll(strict);

    const result = lenient.parse({ name: 'valid', age: 'not a number' });
    expect(result.name).toBe('valid');
    expect(result.age).toBeUndefined();
  });

  it('wraps nested object fields with catch', () => {
    const strict = z.object({
      settings: z.object({
        enabled: z.boolean(),
        name: z.string(),
      }),
    });
    const lenient = withCatchAll(strict);

    const result = lenient.parse({ settings: { enabled: 'bad', name: 'good' } });
    expect(result.settings.enabled).toBeUndefined();
    expect(result.settings.name).toBe('good');
  });

  it('handles optional fields', () => {
    const strict = z.object({ value: z.string().optional() });
    const lenient = withCatchAll(strict);

    const result = lenient.parse({});
    expect(result.value).toBeUndefined();
  });

  it('preserves unknown keys via loose', () => {
    const strict = z.object({ known: z.string() });
    const lenient = withCatchAll(strict);

    const result = lenient.parse({ known: 'hello', extra: 'world' }) as Record<string, unknown>;
    expect(result.known).toBe('hello');
    expect(result.extra).toBe('world');
  });

  it('passes through primitive schemas unchanged', () => {
    const schema = z.string();
    const result = withCatchAll(schema);
    expect(result.parse('hello')).toBe('hello');
  });
});
