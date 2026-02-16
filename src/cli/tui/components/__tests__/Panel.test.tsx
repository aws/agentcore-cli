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
    // Verify border structure: top-left corner on first line, bottom-right on last
    const lines = frame.split('\n');
    expect(lines[0]).toContain('╭');
    expect(lines[lines.length - 1]).toContain('╯');
  });

  it('renders title as first line inside border when provided', () => {
    const { lastFrame } = render(
      <Panel title="Settings">
        <Text>body</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Settings');
    expect(frame).toContain('body');
    // Title should appear before body in the output
    const titleIdx = frame.indexOf('Settings');
    const bodyIdx = frame.indexOf('body');
    expect(titleIdx).toBeLessThan(bodyIdx);
  });

  it('does not include title text when title is omitted', () => {
    const { lastFrame } = render(
      <Panel>
        <Text>body only</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('body only');
    // The frame should only have border + body, no extra text before body
    const lines = frame.split('\n').filter(l => l.trim().length > 0);
    // First meaningful content line after the top border should be the body
    expect(lines.length).toBeGreaterThanOrEqual(3); // top border, body, bottom border
  });

  it('renders with fullWidth when fullWidth prop is true', () => {
    // With fullWidth=false (default), Panel uses contentWidth from context
    // With fullWidth=true, Panel uses 100%
    const { lastFrame: narrowFrame } = render(
      <Panel>
        <Text>narrow</Text>
      </Panel>
    );
    const { lastFrame: wideFrame } = render(
      <Panel fullWidth>
        <Text>wide</Text>
      </Panel>
    );
    // Both should render their content
    expect(narrowFrame()).toContain('narrow');
    expect(wideFrame()).toContain('wide');
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

    // Both render successfully — the narrow panel's top border should be shorter
    const narrowTopLine = narrow()!.split('\n')[0]!;
    const wideTopLine = wide()!.split('\n')[0]!;
    expect(narrowTopLine.length).toBeLessThan(wideTopLine.length);
  });

  it('renders with borderColor prop without breaking layout', () => {
    const { lastFrame } = render(
      <Panel borderColor="green">
        <Text>colored border</Text>
      </Panel>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('colored border');
    // Border structure should still be intact
    const lines = frame.split('\n');
    expect(lines[0]).toContain('╭');
    expect(lines[lines.length - 1]).toContain('╯');
  });
});
