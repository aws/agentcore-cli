import { SelectList } from '../SelectList.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('SelectList', () => {
  const items = [
    { id: 'a', title: 'Agent', description: 'Add an agent' },
    { id: 'b', title: 'Memory', description: 'Add memory' },
    { id: 'c', title: 'Identity' },
  ];

  it('renders all items', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);

    expect(lastFrame()).toContain('Agent');
    expect(lastFrame()).toContain('Memory');
    expect(lastFrame()).toContain('Identity');
  });

  it('shows cursor on selected item', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={1} />);

    expect(lastFrame()).toContain('❯');
    expect(lastFrame()).toContain('Memory');
  });

  it('shows descriptions when provided', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);

    expect(lastFrame()).toContain('Add an agent');
    expect(lastFrame()).toContain('Add memory');
  });

  it('shows empty state when no items', () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} />);

    expect(lastFrame()).toContain('No matches');
    expect(lastFrame()).toContain('No items available');
  });

  it('shows custom empty message', () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} emptyMessage="Nothing here" />);

    expect(lastFrame()).toContain('Nothing here');
  });

  it('renders disabled items', () => {
    const disabledItems = [
      { id: 'a', title: 'Available' },
      { id: 'b', title: 'Disabled', disabled: true },
    ];

    const { lastFrame } = render(<SelectList items={disabledItems} selectedIndex={0} />);

    expect(lastFrame()).toContain('Available');
    expect(lastFrame()).toContain('Disabled');
  });
});
