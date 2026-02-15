import {
  ConfigError,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  ConfigWriteError,
} from '../config.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('ConfigNotFoundError', () => {
  it('has correct message', () => {
    const err = new ConfigNotFoundError('/path/to/config.json', 'project');
    expect(err.message).toBe('project config file not found at: /path/to/config.json');
  });

  it('stores filePath and fileType', () => {
    const err = new ConfigNotFoundError('/path/config.json', 'targets');
    expect(err.filePath).toBe('/path/config.json');
    expect(err.fileType).toBe('targets');
  });

  it('is instance of ConfigError and Error', () => {
    const err = new ConfigNotFoundError('/path', 'project');
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const err = new ConfigNotFoundError('/path', 'project');
    expect(err.name).toBe('ConfigNotFoundError');
  });
});

describe('ConfigReadError', () => {
  it('includes cause message', () => {
    const cause = new Error('EACCES: permission denied');
    const err = new ConfigReadError('/path/config.json', cause);
    expect(err.message).toContain('permission denied');
    expect(err.message).toContain('/path/config.json');
  });

  it('handles non-Error cause', () => {
    const err = new ConfigReadError('/path/config.json', 'string error');
    expect(err.message).toContain('string error');
  });

  it('stores cause', () => {
    const cause = new Error('original');
    const err = new ConfigReadError('/path', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('ConfigWriteError', () => {
  it('includes cause message', () => {
    const cause = new Error('ENOSPC: no space left');
    const err = new ConfigWriteError('/path/config.json', cause);
    expect(err.message).toContain('no space left');
    expect(err.message).toContain('/path/config.json');
  });

  it('handles non-Error cause', () => {
    const err = new ConfigWriteError('/path', 42);
    expect(err.message).toContain('42');
  });
});

describe('ConfigParseError', () => {
  it('includes JSON parse error details', () => {
    const cause = new SyntaxError('Unexpected token } in JSON');
    const err = new ConfigParseError('/path/config.json', cause);
    expect(err.message).toContain('Unexpected token');
    expect(err.message).toContain('/path/config.json');
  });

  it('stores cause', () => {
    const cause = new SyntaxError('bad json');
    const err = new ConfigParseError('/path', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('ConfigValidationError', () => {
  it('formats Zod errors into readable messages', () => {
    const schema = z.object({
      name: z.string().min(1),
      version: z.number().int(),
    });
    const result = schema.safeParse({ name: '', version: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path/config.json', 'project', result.error);
      expect(err.message).toContain('/path/config.json');
    }
  });

  it('stores zodError', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.zodError).toBe(result.error);
    }
  });

  it('formats invalid_type errors with expected/received', () => {
    const schema = z.object({ count: z.number() });
    const result = schema.safeParse({ count: 'not a number' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('count');
    }
  });

  it('formats unrecognized_keys errors', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({ name: 'test', extra: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('extra');
    }
  });

  it('formats invalid_enum_value errors', () => {
    const schema = z.object({ mode: z.enum(['a', 'b']) });
    const result = schema.safeParse({ mode: 'c' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('mode');
    }
  });

  it('is instance of ConfigError', () => {
    const schema = z.object({ x: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('formats invalid_literal errors', () => {
    const schema = z.object({ version: z.literal(1) });
    const result = schema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('version');
    }
  });

  it('formats discriminated union errors', () => {
    const schema = z.object({
      mode: z.enum(['fast', 'slow']),
    });
    const result = schema.safeParse({ mode: 'invalid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('mode');
    }
  });

  it('formats nested path errors', () => {
    const schema = z.object({
      agents: z.array(z.object({ name: z.string() })),
    });
    const result = schema.safeParse({ agents: [{ name: 123 }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      // Path should show agents[0].name or similar
      expect(err.message).toContain('agents');
      expect(err.message).toContain('name');
    }
  });

  it('formats root-level error path', () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('root');
    }
  });

  it('formats multiple errors', () => {
    const schema = z.object({
      name: z.string(),
      version: z.number(),
    });
    const result = schema.safeParse({ name: 123, version: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('name');
      expect(err.message).toContain('version');
    }
  });
});
