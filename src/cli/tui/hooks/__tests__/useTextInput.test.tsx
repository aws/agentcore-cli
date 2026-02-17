import { findNextWordBoundary, findPrevWordBoundary, useTextInput } from '../useTextInput.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';
const BACKSPACE = '\x7f';
const LEFT = '\x1B[D';
const RIGHT = '\x1B[C';

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
  onUpArrow,
  onDownArrow,
  isActive,
}: {
  initialValue?: string;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  onChange?: (value: string) => void;
  onUpArrow?: () => void;
  onDownArrow?: () => void;
  isActive?: boolean;
}) {
  const { value, cursor } = useTextInput({
    initialValue,
    onSubmit,
    onCancel,
    onChange,
    onUpArrow,
    onDownArrow,
    isActive,
  });
  return (
    <Text>
      val:[{value}] cur:{cursor}
    </Text>
  );
}

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

    await delay();
    stdin.write('a');
    await delay();

    expect(lastFrame()).toContain('val:[a]');
    expect(lastFrame()).toContain('cur:1');
  });

  it('accepts multiple characters', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness />);

    await delay();
    stdin.write('h');
    stdin.write('i');
    await delay();

    expect(lastFrame()).toContain('val:[hi]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('handles backspace', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    await delay();
    stdin.write(BACKSPACE);
    await delay();

    expect(lastFrame()).toContain('val:[ab]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('backspace at start does nothing', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="" />);

    await delay();
    stdin.write(BACKSPACE);
    await delay();

    expect(lastFrame()).toContain('val:[]');
    expect(lastFrame()).toContain('cur:0');
  });

  it('calls onSubmit on Enter with current text', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextInputHarness initialValue="test" onSubmit={onSubmit} />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).toHaveBeenCalledWith('test');
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<TextInputHarness onCancel={onCancel} />);

    await delay();
    stdin.write(ESCAPE);
    await delay();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moves cursor left with arrow key', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    await delay();
    stdin.write(LEFT);
    await delay();

    expect(lastFrame()).toContain('val:[abc]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('moves cursor right with arrow key', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="abc" />);

    await delay();
    stdin.write(LEFT);
    stdin.write(LEFT);
    await delay();
    expect(lastFrame()).toContain('cur:1');

    stdin.write(RIGHT);
    await delay();
    expect(lastFrame()).toContain('cur:2');
  });

  it('cursor does not go below 0', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="ab" />);

    await delay();
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT); // try to go past 0
    await delay();

    expect(lastFrame()).toContain('cur:0');
  });

  it('cursor does not go past text length', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="ab" />);

    await delay();
    stdin.write(RIGHT); // already at end (2)
    await delay();

    expect(lastFrame()).toContain('cur:2');
  });

  it('inserts character at cursor position (middle of text)', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="ac" />);

    await delay();
    stdin.write(LEFT); // cursor at 1
    await delay();
    stdin.write('b');
    await delay();

    expect(lastFrame()).toContain('val:[abc]');
    expect(lastFrame()).toContain('cur:2');
  });

  it('calls onChange when text changes', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<TextInputHarness onChange={onChange} />);

    await delay();
    stdin.write('x');
    await delay(100);

    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('calls onUpArrow on up arrow key', async () => {
    const onUpArrow = vi.fn();
    const { stdin } = render(<TextInputHarness onUpArrow={onUpArrow} />);

    await delay();
    stdin.write('\x1B[A'); // up arrow
    await delay();

    expect(onUpArrow).toHaveBeenCalledTimes(1);
  });

  it('calls onDownArrow on down arrow key', async () => {
    const onDownArrow = vi.fn();
    const { stdin } = render(<TextInputHarness onDownArrow={onDownArrow} />);

    await delay();
    stdin.write('\x1B[B'); // down arrow
    await delay();

    expect(onDownArrow).toHaveBeenCalledTimes(1);
  });
});

describe('useTextInput keyboard shortcuts', () => {
  it('Ctrl+A moves cursor to start', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="hello world" />);

    await delay();
    stdin.write('\x01'); // Ctrl+A
    await delay();

    expect(lastFrame()).toContain('val:[hello world]');
    expect(lastFrame()).toContain('cur:0');
  });

  it('Ctrl+E moves cursor to end', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="hello world" />);

    // Move to start first, then Ctrl+E
    await delay();
    stdin.write('\x01'); // Ctrl+A → cursor:0
    await delay();
    stdin.write('\x05'); // Ctrl+E
    await delay();

    expect(lastFrame()).toContain('cur:11');
  });

  it('Ctrl+W deletes previous word', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="hello world" />);

    await delay();
    stdin.write('\x17'); // Ctrl+W
    await delay();

    expect(lastFrame()).toContain('val:[hello ]');
    expect(lastFrame()).toContain('cur:6');
  });

  it('Ctrl+U deletes from cursor to start', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="hello world" />);

    // Move cursor to middle first
    await delay();
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT); // cursor at 6
    await delay();
    stdin.write('\x15'); // Ctrl+U
    await delay();

    expect(lastFrame()).toContain('val:[world]');
    expect(lastFrame()).toContain('cur:0');
  });

  it('Ctrl+K deletes from cursor to end', async () => {
    const { lastFrame, stdin } = render(<TextInputHarness initialValue="hello world" />);

    // Move cursor to position 5
    await delay();
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT); // cursor at 5
    await delay();
    stdin.write('\x0B'); // Ctrl+K
    await delay();

    expect(lastFrame()).toContain('val:[hello]');
    expect(lastFrame()).toContain('cur:5');
  });
});
