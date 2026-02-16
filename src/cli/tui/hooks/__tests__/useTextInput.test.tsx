import { findNextWordBoundary, findPrevWordBoundary, useTextInput } from '../useTextInput.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';
const BACKSPACE = '\x7f';

afterEach(() => vi.restoreAllMocks());

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
    expect(findNextWordBoundary('foo bar baz', 4)).toBe(8);
  });

  it('returns text length for single character', () => {
    expect(findNextWordBoundary('x', 0)).toBe(1);
  });
});

// Wrapper component to test the hook via rendering
function TextInputHarness({
  initialValue = '',
  onSubmit,
  onCancel,
  onChange,
}: {
  initialValue?: string;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  onChange?: (value: string) => void;
}) {
  const { value, cursor } = useTextInput({ initialValue, onSubmit, onCancel, onChange });
  return (
    <Text>
      val:[{value}] cur:{cursor}
    </Text>
  );
}

describe('useTextInput hook', () => {
  it('starts with initial value and cursor at end', () => {
    const { lastFrame } = render(<TextInputHarness initialValue="hello" />);

    expect(lastFrame()).toContain('val:[hello]');
    expect(lastFrame()).toContain('cur:5');
  });

  it('starts empty by default', () => {
    const { lastFrame } = render(<TextInputHarness />);

    expect(lastFrame()).toContain('val:[]');
    expect(lastFrame()).toContain('cur:0');
  });

  it('accepts character input', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('a');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('val:[a]');
    expect(lastFrame()).toContain('cur:1');
  });

  it('accepts multiple characters', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('h');
    stdin.write('i');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('val:[hi]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('handles backspace', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(BACKSPACE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('val:[ab]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('calls onSubmit on Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextInputHarness initialValue="test" onSubmit={onSubmit} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSubmit).toHaveBeenCalledWith('test');
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<TextInputHarness onCancel={onCancel} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moves cursor left with arrow key', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('\x1B[D'); // left arrow
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('val:[abc]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('moves cursor right with arrow key', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    // Move left first, then right
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('\x1B[D'); // left
    stdin.write('\x1B[D'); // left
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('cur:1');

    stdin.write('\x1B[C'); // right arrow
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('cur:2');
  });

  it('inserts character at cursor position', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="ac" />);

    // Move cursor left once (between a and c), then insert b
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('\x1B[D'); // left, cursor now at 1
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('b');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('val:[abc]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('calls onChange when text changes', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<TextInputHarness onChange={onChange} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('x');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(onChange).toHaveBeenCalledWith('x');
  });
});
