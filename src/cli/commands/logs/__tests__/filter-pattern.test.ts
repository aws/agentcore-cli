import { buildFilterPattern } from '../filter-pattern';
import { describe, expect, it } from 'vitest';

describe('buildFilterPattern', () => {
  it('returns level pattern for level only', () => {
    expect(buildFilterPattern({ level: 'error' })).toBe('ERROR');
  });

  it('returns query for query only', () => {
    expect(buildFilterPattern({ query: 'timeout' })).toBe('timeout');
  });

  it('combines level and query with space', () => {
    expect(buildFilterPattern({ level: 'error', query: 'timeout' })).toBe('ERROR timeout');
  });

  it('returns undefined for no options', () => {
    expect(buildFilterPattern({})).toBeUndefined();
  });

  describe('all levels', () => {
    it('maps "error" to "ERROR"', () => {
      expect(buildFilterPattern({ level: 'error' })).toBe('ERROR');
    });

    it('maps "warn" to "WARN"', () => {
      expect(buildFilterPattern({ level: 'warn' })).toBe('WARN');
    });

    it('maps "info" to "INFO"', () => {
      expect(buildFilterPattern({ level: 'info' })).toBe('INFO');
    });

    it('maps "debug" to "DEBUG"', () => {
      expect(buildFilterPattern({ level: 'debug' })).toBe('DEBUG');
    });
  });

  it('is case-insensitive for level', () => {
    expect(buildFilterPattern({ level: 'ERROR' })).toBe('ERROR');
    expect(buildFilterPattern({ level: 'Error' })).toBe('ERROR');
  });

  it('throws for invalid level', () => {
    expect(() => buildFilterPattern({ level: 'trace' })).toThrow('Invalid log level');
  });
});
