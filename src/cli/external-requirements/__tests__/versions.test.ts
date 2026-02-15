import { compareSemVer, formatSemVer, parseSemVer, semVerGte } from '../versions.js';
import { describe, expect, it } from 'vitest';

describe('parseSemVer', () => {
  it('parses standard version string', () => {
    expect(parseSemVer('18.0.0')).toEqual({ major: 18, minor: 0, patch: 0 });
  });

  it('parses version with leading v', () => {
    expect(parseSemVer('v20.10.3')).toEqual({ major: 20, minor: 10, patch: 3 });
  });

  it('parses zero version', () => {
    expect(parseSemVer('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('parses version with extra suffix', () => {
    // The regex stops at three digits so extra text after is ignored
    expect(parseSemVer('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('returns null for invalid format', () => {
    expect(parseSemVer('not-a-version')).toBeNull();
    expect(parseSemVer('')).toBeNull();
    expect(parseSemVer('1.2')).toBeNull();
    expect(parseSemVer('abc')).toBeNull();
  });
});

describe('compareSemVer', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemVer({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
  });

  it('returns positive when a > b by major', () => {
    expect(compareSemVer({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBeGreaterThan(0);
  });

  it('returns negative when a < b by major', () => {
    expect(compareSemVer({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
  });

  it('compares by minor when major is equal', () => {
    expect(compareSemVer({ major: 1, minor: 5, patch: 0 }, { major: 1, minor: 3, patch: 0 })).toBeGreaterThan(0);
    expect(compareSemVer({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 5, patch: 0 })).toBeLessThan(0);
  });

  it('compares by patch when major and minor are equal', () => {
    expect(compareSemVer({ major: 1, minor: 2, patch: 4 }, { major: 1, minor: 2, patch: 3 })).toBeGreaterThan(0);
    expect(compareSemVer({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 4 })).toBeLessThan(0);
  });
});

describe('semVerGte', () => {
  it('returns true when a > b', () => {
    expect(semVerGte({ major: 20, minor: 0, patch: 0 }, { major: 18, minor: 0, patch: 0 })).toBe(true);
  });

  it('returns true when a == b', () => {
    expect(semVerGte({ major: 18, minor: 0, patch: 0 }, { major: 18, minor: 0, patch: 0 })).toBe(true);
  });

  it('returns false when a < b', () => {
    expect(semVerGte({ major: 16, minor: 0, patch: 0 }, { major: 18, minor: 0, patch: 0 })).toBe(false);
  });
});

describe('formatSemVer', () => {
  it('formats version to string', () => {
    expect(formatSemVer({ major: 1, minor: 2, patch: 3 })).toBe('1.2.3');
  });

  it('formats zero version', () => {
    expect(formatSemVer({ major: 0, minor: 0, patch: 0 })).toBe('0.0.0');
  });

  it('formats large version numbers', () => {
    expect(formatSemVer({ major: 100, minor: 200, patch: 300 })).toBe('100.200.300');
  });
});
