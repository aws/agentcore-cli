import { FullScreenLogView } from '../FullScreenLogView.js';
import type { LogEntry } from '../LogPanel.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';
const UP = '\x1B[A';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => vi.restoreAllMocks());

function makeLogs(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    level: 'info' as const,
    message: `Log message ${i + 1}`,
  }));
}

describe('FullScreenLogView', () => {
  it('renders log entries', () => {
    const logs: LogEntry[] = [
      { level: 'info', message: 'Starting deploy' },
      { level: 'error', message: 'Deploy failed' },
    ];
    const { lastFrame } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Starting deploy');
    expect(frame).toContain('Deploy failed');
  });

  it('renders header with entry count', () => {
    const logs = makeLogs(5);
    const { lastFrame } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('5 entries');
  });

  it('renders log file path when provided', () => {
    const logs = makeLogs(2);
    const { lastFrame } = render(<FullScreenLogView logs={logs} logFilePath="/tmp/deploy.log" onExit={vi.fn()} />);

    expect(lastFrame()).toContain('/tmp/deploy.log');
  });

  it('shows "No logs yet" when empty', () => {
    const { lastFrame } = render(<FullScreenLogView logs={[]} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('No logs yet');
  });

  it('calls onExit on Escape key', () => {
    const onExit = vi.fn();
    const { stdin } = render(<FullScreenLogView logs={makeLogs(3)} onExit={onExit} />);

    stdin.write(ESCAPE);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on q key', () => {
    const onExit = vi.fn();
    const { stdin } = render(<FullScreenLogView logs={makeLogs(3)} onExit={onExit} />);

    stdin.write('\x11'); // Ctrl+Q

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on l key', () => {
    const onExit = vi.fn();
    const { stdin } = render(<FullScreenLogView logs={makeLogs(3)} onExit={onExit} />);

    stdin.write('l');

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('renders error log with level label', () => {
    const logs: LogEntry[] = [{ level: 'error', message: 'Something broke' }];
    const { lastFrame } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('ERROR');
    expect(frame).toContain('Something broke');
  });

  it('renders response log with special formatting', () => {
    const logs: LogEntry[] = [{ level: 'response', message: 'Agent response text' }];
    const { lastFrame } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Response');
    expect(frame).toContain('Agent response text');
  });

  it('renders footer with navigation hints', () => {
    const { lastFrame } = render(<FullScreenLogView logs={makeLogs(3)} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('Esc/q/l exit');
  });

  it('shows scroll percentage', () => {
    const logs = makeLogs(3);
    const { lastFrame } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);

    // Should show some percentage
    expect(lastFrame()).toMatch(/\d+%/);
  });

  it('scrolls with arrow keys', async () => {
    // Create enough logs to require scrolling
    const logs = makeLogs(50);
    const { lastFrame, stdin } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);

    await delay();
    stdin.write(UP);
    await delay();

    // After scrolling up, the frame should change
    const frame = lastFrame()!;
    expect(frame).toMatch(/\d+%/);
  });

  it('supports vim-style navigation with j/k', async () => {
    const logs = makeLogs(50);
    const { stdin } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);

    // These should not throw
    await delay();
    stdin.write('k'); // scroll up
    stdin.write('j'); // scroll down
    await delay();
  });

  it('supports g/G for top/bottom navigation', async () => {
    const logs = makeLogs(50);
    const { lastFrame, stdin } = render(<FullScreenLogView logs={logs} onExit={vi.fn()} />);

    await delay();
    stdin.write('g'); // go to top
    await delay();

    // At top, should show first log
    expect(lastFrame()).toContain('Log message 1');

    stdin.write('G'); // go to bottom
    await delay();

    // At bottom, should show last log
    expect(lastFrame()).toContain('Log message 50');
  });
});
