import { diffLines } from '../diff.js';
import { describe, expect, it } from 'vitest';

describe('diffLines', () => {
  it('returns empty array for two empty arrays', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('marks all lines as additions when original is empty', () => {
    const result = diffLines([], ['a', 'b']);
    expect(result).toEqual([
      { prefix: '+', value: 'a', color: 'green' },
      { prefix: '+', value: 'b', color: 'green' },
    ]);
  });

  it('marks all lines as removals when current is empty', () => {
    const result = diffLines(['a', 'b'], []);
    expect(result).toEqual([
      { prefix: '-', value: 'a', color: 'red' },
      { prefix: '-', value: 'b', color: 'red' },
    ]);
  });

  it('shows no changes for identical inputs', () => {
    const lines = ['line1', 'line2', 'line3'];
    const result = diffLines(lines, lines);
    expect(result).toHaveLength(3);
    for (const line of result) {
      expect(line.prefix).toBe(' ');
      expect(line.color).toBeUndefined();
    }
  });

  it('detects a single line change', () => {
    const original = ['a', 'b', 'c'];
    const current = ['a', 'x', 'c'];
    const result = diffLines(original, current);

    expect(result).toContainEqual({ prefix: ' ', value: 'a' });
    expect(result).toContainEqual({ prefix: '-', value: 'b', color: 'red' });
    expect(result).toContainEqual({ prefix: '+', value: 'x', color: 'green' });
    expect(result).toContainEqual({ prefix: ' ', value: 'c' });
  });

  it('detects an insertion', () => {
    const original = ['a', 'c'];
    const current = ['a', 'b', 'c'];
    const result = diffLines(original, current);

    const prefixes = result.map(r => r.prefix);
    expect(prefixes).toContain('+');
    // 'a' and 'c' should be equal, 'b' should be added
    const added = result.filter(r => r.prefix === '+');
    expect(added).toHaveLength(1);
    expect(added[0]!.value).toBe('b');
  });

  it('detects a deletion', () => {
    const original = ['a', 'b', 'c'];
    const current = ['a', 'c'];
    const result = diffLines(original, current);

    const removed = result.filter(r => r.prefix === '-');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.value).toBe('b');
  });

  it('handles complete replacement', () => {
    const original = ['a', 'b'];
    const current = ['x', 'y'];
    const result = diffLines(original, current);

    const removed = result.filter(r => r.prefix === '-');
    const added = result.filter(r => r.prefix === '+');
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(2);
  });

  it('handles multi-line edits correctly', () => {
    const original = ['header', 'old1', 'old2', 'footer'];
    const current = ['header', 'new1', 'footer'];
    const result = diffLines(original, current);

    const equal = result.filter(r => r.prefix === ' ');
    expect(equal.map(r => r.value)).toContain('header');
    expect(equal.map(r => r.value)).toContain('footer');
  });

  it('preserves line values in output', () => {
    const original = ['  indented', 'normal'];
    const current = ['  indented', 'normal'];
    const result = diffLines(original, current);

    expect(result[0]!.value).toBe('  indented');
    expect(result[1]!.value).toBe('normal');
  });

  it('handles single line arrays', () => {
    const result = diffLines(['old'], ['new']);
    expect(result).toContainEqual({ prefix: '-', value: 'old', color: 'red' });
    expect(result).toContainEqual({ prefix: '+', value: 'new', color: 'green' });
  });
});
