import { findNextEnabledIndex } from '../useListNavigation.js';
import { describe, expect, it } from 'vitest';

describe('findNextEnabledIndex', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  describe('without isDisabled', () => {
    it('moves forward by 1', () => {
      expect(findNextEnabledIndex(items, 0, 1)).toBe(1);
      expect(findNextEnabledIndex(items, 2, 1)).toBe(3);
    });

    it('moves backward by 1', () => {
      expect(findNextEnabledIndex(items, 2, -1)).toBe(1);
      expect(findNextEnabledIndex(items, 1, -1)).toBe(0);
    });

    it('wraps forward from last to first', () => {
      expect(findNextEnabledIndex(items, 4, 1)).toBe(0);
    });

    it('wraps backward from first to last', () => {
      expect(findNextEnabledIndex(items, 0, -1)).toBe(4);
    });
  });

  describe('with isDisabled', () => {
    const isDisabled = (item: string) => item === 'b' || item === 'd';

    it('skips disabled items going forward', () => {
      // From 'a' (0), skip 'b' (1), land on 'c' (2)
      expect(findNextEnabledIndex(items, 0, 1, isDisabled)).toBe(2);
    });

    it('skips disabled items going backward', () => {
      // From 'c' (2), skip 'b' (1), land on 'a' (0)
      expect(findNextEnabledIndex(items, 2, -1, isDisabled)).toBe(0);
    });

    it('skips multiple consecutive disabled items', () => {
      const allItems = ['a', 'b', 'c', 'd', 'e'];
      const skip = (item: string) => item === 'b' || item === 'c';
      // From 'a' (0), skip 'b' (1) and 'c' (2), land on 'd' (3)
      expect(findNextEnabledIndex(allItems, 0, 1, skip)).toBe(3);
    });

    it('wraps around to find enabled item', () => {
      // From 'e' (4), wrap to 'a' (0) — 'a' is enabled
      expect(findNextEnabledIndex(items, 4, 1, isDisabled)).toBe(0);
    });

    it('stays in place when all items are disabled', () => {
      const allDisabled = (_item: string) => true;
      expect(findNextEnabledIndex(items, 2, 1, allDisabled)).toBe(2);
      expect(findNextEnabledIndex(items, 2, -1, allDisabled)).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles single-item list', () => {
      expect(findNextEnabledIndex(['only'], 0, 1)).toBe(0);
      expect(findNextEnabledIndex(['only'], 0, -1)).toBe(0);
    });

    it('handles two-item list', () => {
      expect(findNextEnabledIndex(['a', 'b'], 0, 1)).toBe(1);
      expect(findNextEnabledIndex(['a', 'b'], 1, 1)).toBe(0);
    });
  });
});
