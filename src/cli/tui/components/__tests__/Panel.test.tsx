import { Panel } from '../Panel.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockContentWidth } = vi.hoisted(() => ({
  mockContentWidth: { value: 60 },
}));

vi.mock('../../context/index.js', () => ({
  useLayout: () => ({ contentWidth: mockContentWidth.value }),
}));

afterEach(() => {
  mockContentWidth.value = 60;
});

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

  it('adapts to different content widths from context', () => {
    mockContentWidth.value = 30;
    const { lastFrame: narrow } = render(
      <Panel>
        <Text>test</Text>
      </Panel>
    );

    mockContentWidth.value = 100;
    const { lastFrame: wide } = render(
      <Panel>
        <Text>test</Text>
      </Panel>
    );

    const narrowTopLine = narrow()!.split('\n')[0]!;
    const wideTopLine = wide()!.split('\n')[0]!;
    expect(narrowTopLine.length).toBeLessThan(wideTopLine.length);
  });
});
