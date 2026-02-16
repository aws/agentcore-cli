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

describe('ScrollableList', () => {
  it('renders visible items within height', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={3} />);

    // Auto-scrolls to bottom, so last 3 items visible
    expect(lastFrame()).toContain('Deploy complete');
  });

  it('renders title when provided', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={5} title="Deployment Log" />);

    expect(lastFrame()).toContain('Deployment Log');
  });

  it('does not render title when not provided', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={5} />);

    expect(lastFrame()).not.toContain('Deployment Log');
  });

  it('shows scroll indicator when items exceed height', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={3} />);

    expect(lastFrame()).toContain('of 5');
    expect(lastFrame()).toContain('↑↓');
  });

  it('does not show scroll indicator when all items fit', () => {
    const { lastFrame } = render(<ScrollableList items={items} height={10} />);

    expect(lastFrame()).not.toContain('↑↓');
  });

  it('renders timestamps and messages', () => {
    const { lastFrame } = render(<ScrollableList items={items.slice(0, 2)} height={5} />);

    expect(lastFrame()).toContain('[12:00]');
    expect(lastFrame()).toContain('Starting deploy');
    expect(lastFrame()).toContain('[12:01]');
    expect(lastFrame()).toContain('Creating stack');
  });

  it('renders empty list without scroll indicator', () => {
    const { lastFrame } = render(<ScrollableList items={[]} height={5} />);

    expect(lastFrame()).not.toContain('↑↓');
    expect(lastFrame()).not.toContain('of');
  });

  it('scrolls up with arrow key to reveal earlier items', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    // Initially auto-scrolled to bottom — last items visible
    expect(lastFrame()).toContain('Deploy complete');
    expect(lastFrame()).not.toContain('Starting deploy');

    // Scroll up twice to reveal first item
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(UP_ARROW);
    stdin.write(UP_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('Starting deploy');
  });

  it('scrolls down after scrolling up', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    // Scroll up to top
    stdin.write(UP_ARROW);
    stdin.write(UP_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('Starting deploy');

    // Scroll back down
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('Deploy complete');
  });

  it('updates scroll position indicator when scrolling', async () => {
    const { lastFrame, stdin } = render(<ScrollableList items={items} height={3} />);

    // Initially at bottom: items 3-5 of 5
    expect(lastFrame()).toContain('3-5 of 5');

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(UP_ARROW);
    stdin.write(UP_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    // After scrolling up: items 1-3 of 5
    expect(lastFrame()).toContain('1-3 of 5');
  });
});
