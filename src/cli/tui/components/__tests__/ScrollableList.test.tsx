import { ScrollableList } from '../ScrollableList.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

const UP_ARROW = '\x1B[A';
const DOWN_ARROW = '\x1B[B';

const items = [
  { timestamp: '12:00', message: 'Starting deploy', color: 'green' as const },
  { timestamp: '12:01', message: 'Creating stack' },
  { timestamp: '12:02', message: 'Stack created', color: 'green' as const },
  { timestamp: '12:03', message: 'Deploying lambda' },
  { timestamp: '12:04', message: 'Deploy complete' },
];

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ScrollableList', () => {
  it('auto-scrolls to bottom showing last N items in viewport', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={3} />);
    const frame = lastFrame()!;

    // With height=3, auto-scroll shows items 3-5 (offset=2)
    expect(frame).toContain('Stack created');
    expect(frame).toContain('Deploying lambda');
    expect(frame).toContain('Deploy complete');
    // First two items should NOT be visible
    expect(frame).not.toContain('Starting deploy');
    expect(frame).not.toContain('Creating stack');
  });

  it('shows all items when height exceeds item count', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={10} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Starting deploy');
    expect(frame).toContain('Creating stack');
    expect(frame).toContain('Stack created');
    expect(frame).toContain('Deploying lambda');
    expect(frame).toContain('Deploy complete');
  });

  it('renders title when provided', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={5} title="Deployment Log" />);

    expect(lastFrame()).toContain('Deployment Log');
  });

  it('does not render title when not provided', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={5} />);

    expect(lastFrame()).not.toContain('Deployment Log');
  });

  it('shows scroll indicator with position when items exceed height', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={3} />);
    const frame = lastFrame()!;

    // Auto-scrolled to bottom: items 3-5 of 5
    expect(frame).toContain('3-5 of 5');
    expect(frame).toContain('↑↓');
  });

  it('does not show scroll indicator when all items fit', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={10} />);

    expect(lastFrame()).not.toContain('↑↓');
    expect(lastFrame()).not.toContain('of');
  });

  it('formats items as [timestamp] message', () => {
    const { lastFrame } = render(<ScrollableList items={items.slice(0, 2)} height={5} />);
    const frame = lastFrame()!;

    expect(frame).toContain('[12:00] Starting deploy');
    expect(frame).toContain('[12:01] Creating stack');
  });

  it('renders empty list without scroll indicator', () => {
    const { lastFrame } = render(<ScrollableList items={[]} height={5} />);
    const frame = lastFrame()!;

    expect(frame).not.toContain('↑↓');
    expect(frame).not.toContain('of');
  });

  it('scrolls up to reveal earlier items', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    // Initially auto-scrolled to bottom
    expect(lastFrame()).not.toContain('Starting deploy');
    expect(lastFrame()).toContain('Deploy complete');

    // Scroll up twice
    await delay();
    stdin.write(UP_ARROW);
    stdin.write(UP_ARROW);
    await delay();

    // Now should see first items
    expect(lastFrame()).toContain('Starting deploy');
    // Position indicator should update
    expect(lastFrame()).toContain('1-3 of 5');
  });

  it('scrolls down after scrolling up', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    await delay();
    // Scroll up to top
    stdin.write(UP_ARROW);
    stdin.write(UP_ARROW);
    await delay();
    expect(lastFrame()).toContain('Starting deploy');

    // Scroll back down
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    await delay();

    expect(lastFrame()).toContain('Deploy complete');
    expect(lastFrame()).toContain('3-5 of 5');
  });

  it('does not scroll above first item', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    await delay();
    // Scroll up many times past the top
    for (let i = 0; i < 10; i++) {
      stdin.write(UP_ARROW);
    }
    await delay();

    // Should be at position 1-3, not negative
    expect(lastFrame()).toContain('1-3 of 5');
    expect(lastFrame()).toContain('Starting deploy');
  });

  it('does not scroll below last item', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    await delay();
    // Already at bottom, try scrolling down more
    for (let i = 0; i < 10; i++) {
      stdin.write(DOWN_ARROW);
    }
    await delay();

    // Should still be at bottom position
    expect(lastFrame()).toContain('3-5 of 5');
    expect(lastFrame()).toContain('Deploy complete');
  });
});
