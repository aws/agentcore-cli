import { compareVersions } from '../action.js';
import { describe, expect, it } from 'vitest';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when latest is newer by major', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(1);
  });

  it('returns 1 when latest is newer by minor', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBe(1);
  });

  it('returns 1 when latest is newer by patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(1);
  });

  it('returns -1 when current is newer by major', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(-1);
  });

  it('returns -1 when current is newer by minor', () => {
    expect(compareVersions('1.5.0', '1.3.0')).toBe(-1);
  });

  it('returns -1 when current is newer by patch', () => {
    expect(compareVersions('1.2.5', '1.2.3')).toBe(-1);
  });

  it('handles versions with missing parts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});
