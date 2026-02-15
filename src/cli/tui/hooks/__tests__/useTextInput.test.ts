import { findNextWordBoundary, findPrevWordBoundary } from '../useTextInput.js';
import { describe, expect, it } from 'vitest';

describe('findPrevWordBoundary', () => {
  it('returns 0 when cursor is at start', () => {
    expect(findPrevWordBoundary('hello world', 0)).toBe(0);
  });

  it('moves to start of current word', () => {
    expect(findPrevWordBoundary('hello world', 8)).toBe(6);
  });

  it('skips trailing spaces before previous word', () => {
    expect(findPrevWordBoundary('hello world', 6)).toBe(0);
  });

  it('moves to start from end of single word', () => {
    expect(findPrevWordBoundary('hello', 5)).toBe(0);
  });

  it('handles multiple spaces between words', () => {
    expect(findPrevWordBoundary('hello   world', 8)).toBe(0);
  });

  it('handles cursor in middle of word', () => {
    expect(findPrevWordBoundary('hello world', 3)).toBe(0);
  });

  it('handles three words', () => {
    // cursor at 'b' in 'baz': "foo bar baz"
    //                                   ^8
    expect(findPrevWordBoundary('foo bar baz', 8)).toBe(4);
  });

  it('returns 0 for single character', () => {
    expect(findPrevWordBoundary('x', 1)).toBe(0);
  });
});

describe('findNextWordBoundary', () => {
  it('returns text length when cursor is at end', () => {
    expect(findNextWordBoundary('hello world', 11)).toBe(11);
  });

  it('moves past current word and spaces to next word', () => {
    expect(findNextWordBoundary('hello world', 0)).toBe(6);
  });

  it('moves from middle of word to start of next word', () => {
    expect(findNextWordBoundary('hello world', 3)).toBe(6);
  });

  it('moves to end from start of last word', () => {
    expect(findNextWordBoundary('hello world', 6)).toBe(11);
  });

  it('handles multiple spaces between words', () => {
    expect(findNextWordBoundary('hello   world', 0)).toBe(8);
  });

  it('handles single word', () => {
    expect(findNextWordBoundary('hello', 0)).toBe(5);
  });

  it('handles three words', () => {
    // from 'b' in 'bar': "foo bar baz"
    //                          ^4
    expect(findNextWordBoundary('foo bar baz', 4)).toBe(8);
  });

  it('returns text length for single character', () => {
    expect(findNextWordBoundary('x', 0)).toBe(1);
  });
});
