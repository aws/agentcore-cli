import type { LogEntry } from '../LogPanel.js';
import { LogPanel } from '../LogPanel.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UP_ARROW = '\x1B[A';
const DOWN_ARROW = '\x1B[B';

afterEach(() => vi.restoreAllMocks());

const makeLogs = (count: number, level: LogEntry['level'] = 'system'): LogEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    level,
    message: `Log message ${i + 1}`,
  }));

describe('LogPanel', () => {
  describe('empty state', () => {
    it('renders "No output yet" with no other content', () => {
      const { lastFrame } = render(<LogPanel logs={[]} />);
      expect(lastFrame()).toBe('No output yet');
    });
  });

  describe('rendering', () => {
    it('renders system log messages without level label', () => {
      const logs: LogEntry[] = [{ level: 'system', message: 'Agent started' }];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      const frame = lastFrame()!;
      expect(frame).toContain('Agent started');
      // System logs don't show the level label prefix
      expect(frame).not.toContain('SYSTEM');
    });

    it('renders response logs with "Response" separator and message', () => {
      const logs: LogEntry[] = [{ level: 'response', message: 'Hello from agent' }];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      const frame = lastFrame()!;
      expect(frame).toContain('─── Response ───');
      expect(frame).toContain('Hello from agent');
    });

    it('renders error logs with ERROR level prefix', () => {
      const logs: LogEntry[] = [{ level: 'error', message: 'Something broke' }];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      const frame = lastFrame()!;
      // ERROR label is padded to 6 chars
      expect(frame).toMatch(/ERROR\s+Something broke/);
    });

    it('renders warn logs with WARN level prefix', () => {
      const logs: LogEntry[] = [{ level: 'warn', message: 'Slow response' }];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).toMatch(/WARN\s+Slow response/);
    });
  });

  describe('minimal filtering', () => {
    it('hides info-level logs in minimal mode (default)', () => {
      const logs: LogEntry[] = [
        { level: 'info', message: 'Debug info' },
        { level: 'system', message: 'Visible system log' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).not.toContain('Debug info');
      expect(lastFrame()).toContain('Visible system log');
    });

    it('hides logs containing JSON debug markers like "timestamp" or "level"', () => {
      const logs: LogEntry[] = [
        { level: 'error', message: '{"timestamp": "2024-01-01", "level": "ERROR"}' },
        { level: 'system', message: 'Visible log' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).not.toContain('timestamp');
      expect(lastFrame()).toContain('Visible log');
    });

    it('hides warn/error logs starting with [ or { as JSON debug', () => {
      const logs: LogEntry[] = [
        { level: 'warn', message: '[{"key": "value"}]' },
        { level: 'error', message: '{"error": "details"}' },
        { level: 'system', message: 'Keep this' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).not.toContain('key');
      expect(lastFrame()).not.toContain('details');
      expect(lastFrame()).toContain('Keep this');
    });

    it('always shows response and system logs even with JSON-like content', () => {
      const logs: LogEntry[] = [
        { level: 'response', message: '{"data": "json response"}' },
        { level: 'system', message: '{"internal": true}' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).toContain('json response');
      expect(lastFrame()).toContain('internal');
    });

    it('shows plain error/warn messages that are not JSON', () => {
      const logs: LogEntry[] = [
        { level: 'error', message: 'Connection timeout' },
        { level: 'warn', message: 'Retrying in 5s' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} />);
      expect(lastFrame()).toContain('Connection timeout');
      expect(lastFrame()).toContain('Retrying in 5s');
    });

    it('shows all logs including info when minimal is false', () => {
      const logs: LogEntry[] = [
        { level: 'info', message: 'Debug info visible' },
        { level: 'system', message: 'System log' },
      ];
      const { lastFrame } = render(<LogPanel logs={logs} minimal={false} />);
      expect(lastFrame()).toContain('Debug info visible');
      expect(lastFrame()).toContain('System log');
    });
  });

  describe('scrolling', () => {
    it('shows "↑↓ scroll" indicator when logs exceed maxLines', () => {
      const logs = makeLogs(20);
      const { lastFrame } = render(<LogPanel logs={logs} maxLines={5} minimal={false} />);
      expect(lastFrame()).toContain('↑↓ scroll');
    });

    it('does not show scroll indicator when all logs fit in maxLines', () => {
      const logs = makeLogs(3);
      const { lastFrame } = render(<LogPanel logs={logs} maxLines={10} minimal={false} />);
      expect(lastFrame()).not.toContain('↑↓ scroll');
    });

    it('auto-scrolls to bottom showing latest logs', () => {
      const logs = makeLogs(20);
      const { lastFrame } = render(<LogPanel logs={logs} maxLines={5} minimal={false} />);
      const frame = lastFrame()!;
      // Should show the last 5 logs (16-20) and "more above"
      expect(frame).toContain('Log message 20');
      expect(frame).toContain('Log message 16');
      // 'Log message 1' would match 'Log message 16' etc, so use regex for exact match
      expect(frame).not.toMatch(/Log message 1\b/);
      expect(frame).toContain('more above');
    });

    it('switches to manual scroll on up arrow, showing earliest logs', async () => {
      const logs = makeLogs(20);
      const { lastFrame, stdin } = render(<LogPanel logs={logs} maxLines={5} minimal={false} />);

      // Initially auto-scrolled to bottom
      expect(lastFrame()).toContain('Log message 20');

      // Up arrow sets userScrolled=true and scrollOffset stays at 0 (initial state),
      // so we jump to the top of the log showing messages 1-5
      await new Promise(resolve => setTimeout(resolve, 50));
      stdin.write(UP_ARROW);
      await new Promise(resolve => setTimeout(resolve, 50));

      const frame = lastFrame()!;
      expect(frame).toContain('Log message 1');
      expect(frame).not.toContain('Log message 20');
      expect(frame).toContain('more below');
    });

    it('scrolls back down to bottom after scrolling up', async () => {
      const logs = makeLogs(20);
      const { lastFrame, stdin } = render(<LogPanel logs={logs} maxLines={5} minimal={false} />);

      // Scroll up to top
      await new Promise(resolve => setTimeout(resolve, 50));
      stdin.write(UP_ARROW);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(lastFrame()).toContain('Log message 1');

      // Scroll down past maxScroll (15) to reach the bottom
      for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        stdin.write(DOWN_ARROW);
      }
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(lastFrame()).toContain('Log message 20');
    });

    it('supports vim-style j/k keys for scrolling', async () => {
      const logs = makeLogs(20);
      const { lastFrame, stdin } = render(<LogPanel logs={logs} maxLines={5} minimal={false} />);

      // k scrolls up (same as up arrow)
      await new Promise(resolve => setTimeout(resolve, 50));
      stdin.write('k');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(lastFrame()).toContain('Log message 1');

      // j scrolls down
      stdin.write('j');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(lastFrame()).toContain('Log message 2');
    });
  });
});
