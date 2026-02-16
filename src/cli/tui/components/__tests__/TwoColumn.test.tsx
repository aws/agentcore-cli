import { TwoColumn } from '../TwoColumn.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockWidth, mockIsNarrow } = vi.hoisted(() => ({
  mockWidth: { value: 120 },
  mockIsNarrow: { value: false },
}));

vi.mock('../../hooks/useResponsive.js', () => ({
  useResponsive: () => ({
    width: mockWidth.value,
    height: 40,
    isNarrow: mockIsNarrow.value,
  }),
}));

afterEach(() => {
  mockWidth.value = 120;
  mockIsNarrow.value = false;
});

describe('TwoColumn', () => {
  it('renders both left and right content on wide screen', () => {
    const { lastFrame } = render(<TwoColumn left={<Text>LEFT_MARKER</Text>} right={<Text>RIGHT_MARKER</Text>} />);
    const frame = lastFrame()!;
    expect(frame).toContain('LEFT_MARKER');
    expect(frame).toContain('RIGHT_MARKER');
    // On wide screen, both should be on the same line (side by side)
    const lines = frame.split('\n');
    const lineWithLeft = lines.find(l => l.includes('LEFT_MARKER'));
    expect(lineWithLeft).toContain('RIGHT_MARKER');
  });

  it('stacks columns vertically on narrow screen', () => {
    mockIsNarrow.value = true;
    mockWidth.value = 40;

    const { lastFrame } = render(<TwoColumn left={<Text>LEFT_MARKER</Text>} right={<Text>RIGHT_MARKER</Text>} />);
    const frame = lastFrame()!;
    expect(frame).toContain('LEFT_MARKER');
    expect(frame).toContain('RIGHT_MARKER');
    // On narrow screen, left and right should be on different lines (stacked)
    const lines = frame.split('\n');
    const lineWithLeft = lines.find(l => l.includes('LEFT_MARKER'));
    expect(lineWithLeft).not.toContain('RIGHT_MARKER');
  });

  it('renders only left content when no right provided', () => {
    const { lastFrame } = render(<TwoColumn left={<Text>Only left</Text>} />);
    expect(lastFrame()).toContain('Only left');
  });

  it('stacks when width is below collapseBelow threshold', () => {
    mockWidth.value = 60;
    mockIsNarrow.value = false;

    const { lastFrame } = render(
      <TwoColumn left={<Text>LEFT_MARKER</Text>} right={<Text>RIGHT_MARKER</Text>} collapseBelow={80} />
    );
    // Width 60 < collapseBelow 80 → stacked
    const lines = lastFrame()!.split('\n');
    const lineWithLeft = lines.find(l => l.includes('LEFT_MARKER'));
    expect(lineWithLeft).not.toContain('RIGHT_MARKER');
  });

  it('shows side-by-side when width exceeds collapseBelow', () => {
    mockWidth.value = 120;
    mockIsNarrow.value = false;

    const { lastFrame } = render(
      <TwoColumn left={<Text>LEFT_MARKER</Text>} right={<Text>RIGHT_MARKER</Text>} collapseBelow={80} />
    );
    // Width 120 > collapseBelow 80 → side by side
    const lines = lastFrame()!.split('\n');
    const lineWithLeft = lines.find(l => l.includes('LEFT_MARKER'));
    expect(lineWithLeft).toContain('RIGHT_MARKER');
  });

  it('renders both columns with custom ratio prop', () => {
    mockWidth.value = 120;
    mockIsNarrow.value = false;

    const { lastFrame } = render(
      <TwoColumn left={<Text>LEFT_MARKER</Text>} right={<Text>RIGHT_MARKER</Text>} ratio={[3, 1]} />
    );
    // Both columns should still render side-by-side with a 3:1 ratio
    const lines = lastFrame()!.split('\n');
    const lineWithLeft = lines.find(l => l.includes('LEFT_MARKER'));
    expect(lineWithLeft).toContain('RIGHT_MARKER');
  });
});
