import { parseTimeString } from '../../../../lib/utils/time-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('parseTimeString', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('relative durations', () => {
    it('parses "5m" as 5 minutes ago', () => {
      const result = parseTimeString('5m');
      expect(result).toBe(Date.now() - 5 * 60_000);
    });

    it('parses "1h" as 1 hour ago', () => {
      const result = parseTimeString('1h');
      expect(result).toBe(Date.now() - 3_600_000);
    });

    it('parses "2d" as 2 days ago', () => {
      const result = parseTimeString('2d');
      expect(result).toBe(Date.now() - 2 * 86_400_000);
    });

    it('parses "30s" as 30 seconds ago', () => {
      const result = parseTimeString('30s');
      expect(result).toBe(Date.now() - 30_000);
    });
  });

  describe('ISO 8601', () => {
    it('parses ISO timestamp', () => {
      const result = parseTimeString('2026-03-02T14:30:00Z');
      expect(result).toBe(new Date('2026-03-02T14:30:00Z').getTime());
    });
  });

  describe('epoch milliseconds', () => {
    it('passes through epoch ms', () => {
      const result = parseTimeString('1709391000000');
      expect(result).toBe(1709391000000);
    });
  });

  describe('"now"', () => {
    it('returns approximately Date.now()', () => {
      const result = parseTimeString('now');
      expect(result).toBe(Date.now());
    });
  });

  describe('invalid input', () => {
    it('throws for "abc"', () => {
      expect(() => parseTimeString('abc')).toThrow('Invalid time string');
    });

    it('throws for empty string', () => {
      expect(() => parseTimeString('')).toThrow('Time string cannot be empty');
    });

    it('throws for "5x" (invalid unit)', () => {
      expect(() => parseTimeString('5x')).toThrow('Invalid time string');
    });
  });
});
