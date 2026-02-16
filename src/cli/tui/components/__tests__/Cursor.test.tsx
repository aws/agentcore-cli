import { Cursor } from '../Cursor.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('Cursor', () => {
  it('renders the provided character on initial mount', () => {
    const { lastFrame } = render(<Cursor char="X" />);
    expect(lastFrame()).toContain('X');
  });

  it('sets up a blink interval using setInterval', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(<Cursor char="A" interval={500} />);
    // Cursor uses setInterval with the provided interval for blinking
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 500);
  });

  it('uses custom interval value for the blink timer', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(<Cursor char="B" interval={200} />);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 200);
  });

  it('renders with default space character when no char prop given', () => {
    const { lastFrame } = render(<Cursor />);
    // Default char is a space — component should render without errors
    expect(lastFrame()).toBeDefined();
  });

  it('cleans up interval timer on unmount', () => {
    const spy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<Cursor char="C" interval={200} />);
    unmount();
    // clearInterval should be called during cleanup
    expect(spy).toHaveBeenCalled();
  });
});
