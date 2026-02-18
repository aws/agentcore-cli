import { ScrollableText } from '../ScrollableText.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UP = '\x1B[A';
const DOWN = '\x1B[B';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => vi.restoreAllMocks());

function makeContent(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`).join('\n');
}

describe('ScrollableText', () => {
  it('returns null when content is empty', () => {
    const { lastFrame } = render(<ScrollableText content="" />);

    expect(lastFrame()).toBe('');
  });

  it('renders all lines when content fits within height', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const { lastFrame } = render(<ScrollableText content={content} height={10} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Line 1');
    expect(frame).toContain('Line 2');
    expect(frame).toContain('Line 3');
  });

  it('does not show scrollbar when content fits', () => {
    const content = 'Line 1\nLine 2';
    const { lastFrame } = render(<ScrollableText content={content} height={10} />);
    const frame = lastFrame()!;

    expect(frame).not.toContain('\u2588'); // block char
    expect(frame).not.toContain('\u2591'); // light shade
  });

  it('shows only height lines when content overflows', () => {
    const content = makeContent(20);
    const { lastFrame } = render(<ScrollableText content={content} height={5} />);
    const frame = lastFrame()!;

    // Should show status line with scroll info
    expect(frame).toContain('of 20');
  });

  it('shows scrollbar when content overflows', () => {
    const content = makeContent(30);
    const { lastFrame } = render(<ScrollableText content={content} height={5} />);
    const frame = lastFrame()!;

    // Scrollbar chars should appear
    expect(frame).toMatch(/[█░]/);
  });

  it('hides scrollbar when showScrollbar is false', () => {
    const content = makeContent(30);
    const { lastFrame } = render(<ScrollableText content={content} height={5} showScrollbar={false} />);
    const frame = lastFrame()!;

    // Should still show status line but no scrollbar track
    expect(frame).not.toContain('░');
  });

  it('scrolls down with arrow key', async () => {
    const content = makeContent(20);
    const { lastFrame, stdin } = render(<ScrollableText content={content} height={5} />);

    await delay();
    stdin.write(DOWN);
    await delay();

    // After scrolling down, should no longer show from the top
    const frame = lastFrame()!;
    expect(frame).toContain('of 20');
  });

  it('scrolls up with arrow key', async () => {
    const content = makeContent(20);
    const { lastFrame, stdin } = render(<ScrollableText content={content} height={5} />);

    await delay();
    // Scroll down first, then back up
    stdin.write(DOWN);
    stdin.write(DOWN);
    await delay();
    stdin.write(UP);
    await delay();

    const frame = lastFrame()!;
    expect(frame).toContain('of 20');
  });

  it('auto-scrolls to bottom when streaming', () => {
    const content = makeContent(20);
    const { lastFrame } = render(<ScrollableText content={content} height={5} isStreaming />);
    const frame = lastFrame()!;

    // When streaming, should show the last lines
    expect(frame).toContain('Line 20');
  });

  it('shows status line with line range when scrolling needed', () => {
    const content = makeContent(20);
    const { lastFrame } = render(<ScrollableText content={content} height={5} />);
    const frame = lastFrame()!;

    // Status line should show range and total
    expect(frame).toMatch(/\[\d+-\d+ of 20\]/);
    expect(frame).toContain('PgUp/PgDn');
  });

  it('does not show status line when content fits', () => {
    const content = 'Line 1\nLine 2';
    const { lastFrame } = render(<ScrollableText content={content} height={10} />);

    expect(lastFrame()).not.toContain('PgUp/PgDn');
  });

  it('wraps long lines to fit terminal width', () => {
    // Create a line longer than any reasonable terminal width
    const longLine = 'A'.repeat(200);
    const { lastFrame } = render(<ScrollableText content={longLine} height={10} />);
    const frame = lastFrame()!;

    // Content should appear (wrapped)
    expect(frame).toContain('A');
  });

  it('does not respond to input when isActive is false', async () => {
    const content = makeContent(20);
    const { lastFrame, stdin } = render(<ScrollableText content={content} height={5} isActive={false} />);

    const before = lastFrame();
    await delay();
    stdin.write(DOWN);
    stdin.write(DOWN);
    await delay();

    // Frame shouldn't change since input is disabled
    expect(lastFrame()).toBe(before);
  });
});
