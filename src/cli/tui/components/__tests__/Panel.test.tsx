import { Panel } from '../Panel.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../context/index.js', () => ({
  useLayout: () => ({ contentWidth: 80 }),
}));

describe('Panel', () => {
  it('renders children content inside a border', () => {
    const { lastFrame } = render(
      <Panel>
        <Text>Panel body</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Panel body');
    const lines = frame.split('\n');
    expect(lines[0]).toContain('╭');
    expect(lines[lines.length - 1]).toContain('╯');
  });

  it('renders title before body content', () => {
    const { lastFrame } = render(
      <Panel title="Settings">
        <Text>body</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Settings');
    expect(frame.indexOf('Settings')).toBeLessThan(frame.indexOf('body'));
  });

  it('defaults to full width', () => {
    const { lastFrame } = render(
      <Panel>
        <Text>test</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    const topLine = frame.split('\n')[0]!;
    expect(topLine.length).toBeGreaterThan(80);
  });
});
