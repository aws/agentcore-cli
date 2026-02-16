import { MultiSelectList } from '../MultiSelectList.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('MultiSelectList', () => {
  const items = [
    { id: 'agent-1', title: 'Agent One' },
    { id: 'agent-2', title: 'Agent Two', description: 'Secondary agent' },
    { id: 'agent-3', title: 'Agent Three' },
  ];

  it('renders all items with checkboxes', () => {
    const { lastFrame } = render(<MultiSelectList items={items} selectedIndex={0} selectedIds={new Set()} />);

    expect(lastFrame()).toContain('Agent One');
    expect(lastFrame()).toContain('Agent Two');
    expect(lastFrame()).toContain('Agent Three');
    expect(lastFrame()).toContain('[ ]');
  });

  it('shows checked items', () => {
    const { lastFrame } = render(
      <MultiSelectList items={items} selectedIndex={0} selectedIds={new Set(['agent-1', 'agent-3'])} />
    );

    expect(lastFrame()).toContain('[✓]');
  });

  it('shows cursor on current index', () => {
    const { lastFrame } = render(<MultiSelectList items={items} selectedIndex={1} selectedIds={new Set()} />);

    expect(lastFrame()).toContain('❯');
  });

  it('shows descriptions', () => {
    const { lastFrame } = render(<MultiSelectList items={items} selectedIndex={0} selectedIds={new Set()} />);

    expect(lastFrame()).toContain('Secondary agent');
  });

  it('shows empty state when no items', () => {
    const { lastFrame } = render(<MultiSelectList items={[]} selectedIndex={0} selectedIds={new Set()} />);

    expect(lastFrame()).toContain('No agents found');
  });

  it('shows custom empty message', () => {
    const { lastFrame } = render(
      <MultiSelectList items={[]} selectedIndex={0} selectedIds={new Set()} emptyMessage="No targets" />
    );

    expect(lastFrame()).toContain('No targets');
  });
});
