import { compareVersions } from '../action.js';
import { describe, expect, it } from 'vitest';

describe('update', () => {
  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('2.5.3', '2.5.3')).toBe(0);
    });

    it('returns 1 when latest is newer (update available)', () => {
      expect(compareVersions('1.0.0', '1.0.1')).toBe(1);
      expect(compareVersions('1.0.0', '1.1.0')).toBe(1);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(1);
      expect(compareVersions('1.9.9', '2.0.0')).toBe(1);
    });

    it('returns -1 when current is newer (local ahead)', () => {
      expect(compareVersions('1.0.1', '1.0.0')).toBe(-1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe(-1);
      expect(compareVersions('2.0.0', '1.0.0')).toBe(-1);
      expect(compareVersions('2.0.0', '1.9.9')).toBe(-1);
    });

    it('handles missing patch version', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', '1.0')).toBe(0);
      expect(compareVersions('1.0', '1.0.1')).toBe(1);
    });

    it('compares major version first', () => {
      expect(compareVersions('1.9.9', '2.0.0')).toBe(1);
      expect(compareVersions('2.0.0', '1.9.9')).toBe(-1);
    });
  });
});
