import {
  ConfigError,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  ConfigWriteError,
} from '../config.js';
import { describe, expect, it } from 'vitest';
import { ZodError, ZodIssueCode, z } from 'zod';

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
  it('stores zodError and is instance of ConfigError', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.zodError).toBe(result.error);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('includes file path in message', () => {
    const schema = z.object({ name: z.string().min(1) });
    const result = schema.safeParse({ name: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path/config.json', 'project', result.error);
      expect(err.message).toContain('/path/config.json');
    }
  });

  it('formats multiple errors', () => {
    const schema = z.object({ name: z.string(), version: z.number() });
    const result = schema.safeParse({ name: 123, version: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new ConfigValidationError('/path', 'project', result.error);
      expect(err.message).toContain('name');
      expect(err.message).toContain('version');
    }
  });

  describe('formatZodIssue branches', () => {
    it('formats invalid_type with expected type', () => {
      const schema = z.object({ count: z.number() });
      const result = schema.safeParse({ count: 'hello' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toContain('count');
        expect(err.message).toContain('expected');
      }
    });

    it('formats invalid_type with expected only (no received)', () => {
      // Zod always sets received, so use a synthetic ZodError to test the branch
      // where received is undefined (line 92-93 of config.ts)
      const zodError = new ZodError([
        {
          code: ZodIssueCode.invalid_type,
          path: ['field'],
          message: 'Expected string',
          expected: 'string',
        } as any,
      ]);
      const err = new ConfigValidationError('/path', 'project', zodError);
      expect(err.message).toContain('field');
      expect(err.message).toContain('expected "string"');
      expect(err.message).not.toContain('got');
    });

    it('formats invalid_enum_value with received value and valid options', () => {
      const schema = z.object({ mode: z.enum(['fast', 'slow', 'balanced']) });
      const result = schema.safeParse({ mode: 'turbo' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toContain('mode');
        expect(err.message).toMatch(/"fast"|"slow"|"balanced"/);
      }
    });

    it('formats invalid_literal with got and expected values', () => {
      // Use synthetic ZodError since Zod may emit invalid_value instead of invalid_literal
      const zodError = new ZodError([
        {
          code: 'invalid_literal',
          path: ['version'],
          message: 'Invalid literal',
          expected: 1,
          received: 2,
        } as any,
      ]);
      const err = new ConfigValidationError('/path', 'project', zodError);
      expect(err.message).toContain('version');
      expect(err.message).toContain('got 2');
      expect(err.message).toContain('expected 1');
    });

    it('formats unrecognized_keys listing the unknown keys', () => {
      const schema = z.object({ name: z.string() }).strict();
      const result = schema.safeParse({ name: 'test', extra: true, bonus: 42 });
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toContain('unknown keys');
        expect(err.message).toContain('"extra"');
        expect(err.message).toContain('"bonus"');
      }
    });

    it('formats invalid_union_discriminator with options', () => {
      // Use synthetic ZodError with string code since ZodIssueCode may not include
      // invalid_union_discriminator in all Zod versions
      const zodError = new ZodError([
        {
          code: 'invalid_union_discriminator',
          path: ['kind'],
          message: 'Invalid discriminator',
          options: ['cat', 'dog'],
        } as any,
      ]);
      const err = new ConfigValidationError('/path', 'project', zodError);
      expect(err.message).toContain('"cat"');
      expect(err.message).toContain('"dog"');
      expect(err.message).toMatch(/"cat" \| "dog"/);
    });

    it('formats invalid_union with discriminator field (Zod 4)', () => {
      // Construct a synthetic invalid_union issue with discriminator property
      const zodError = new ZodError([
        {
          code: ZodIssueCode.invalid_union,
          path: ['config'],
          message: 'Invalid union',
        } as any,
      ]);
      (zodError.issues[0] as any).discriminator = 'type';

      const err = new ConfigValidationError('/path', 'project', zodError);
      expect(err.message).toContain('invalid "type" value');
    });

    it('crashes on invalid_union with nested errors missing path (known bug)', () => {
      // z.union produces invalid_union issues where nested errors lack `path`.
      // formatPath(issue.path) crashes because path is undefined.
      const schema = z.union([z.string(), z.number()]);
      const result = schema.safeParse(true);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(() => new ConfigValidationError('/path', 'project', result.error)).toThrow(
          /Cannot read properties of undefined/
        );
      }
    });

    it('falls back to Zod message for custom issue codes (refine)', () => {
      const schema = z.string().refine(v => v.length > 5, { message: 'Too short' });
      const result = schema.safeParse('hi');
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toContain('Too short');
      }
    });
  });

  describe('formatPath', () => {
    it('formats root-level error as "root"', () => {
      const schema = z.string();
      const result = schema.safeParse(123);
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toContain('root');
      }
    });

    it('formats nested path with array indices as bracket notation', () => {
      const schema = z.object({
        agents: z.array(z.object({ name: z.string() })),
      });
      const result = schema.safeParse({ agents: [{ name: 123 }] });
      expect(result.success).toBe(false);
      if (!result.success) {
        const err = new ConfigValidationError('/path', 'project', result.error);
        expect(err.message).toMatch(/agents\[0\]\.name/);
      }
    });
  });
});
