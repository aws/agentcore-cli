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

  it('renders all item titles', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Agent');
    expect(frame).toContain('Memory');
    expect(frame).toContain('Identity');
  });

  it('shows cursor only on the selected item line', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={1} />);
    const lines = lastFrame()!.split('\n');

    const agentLine = lines.find(l => l.includes('Agent'))!;
    const memoryLine = lines.find(l => l.includes('Memory'))!;
    const identityLine = lines.find(l => l.includes('Identity'))!;

    expect(memoryLine).toContain('❯');
    expect(agentLine).not.toContain('❯');
    expect(identityLine).not.toContain('❯');
  });

  it('moves cursor when selectedIndex changes', () => {
    const { lastFrame: frame0 } = render(<SelectList items={items} selectedIndex={0} />);
    const lines0 = frame0()!.split('\n');
    expect(lines0.find(l => l.includes('Agent'))).toContain('❯');
    expect(lines0.find(l => l.includes('Memory'))).not.toContain('❯');

    const { lastFrame: frame2 } = render(<SelectList items={items} selectedIndex={2} />);
    const lines2 = frame2()!.split('\n');
    expect(lines2.find(l => l.includes('Identity'))).toContain('❯');
    expect(lines2.find(l => l.includes('Agent'))).not.toContain('❯');
    expect(lines2.find(l => l.includes('Memory'))).not.toContain('❯');
  });

  it('shows descriptions inline with items', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Add an agent');
    expect(frame).toContain('Add memory');
    // Identity has no description
    const identityLine = frame.split('\n').find(l => l.includes('Identity'))!;
    expect(identityLine).not.toContain(' - ');
  });

  it('shows empty state with default message when no items', () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} />);
    const frame = lastFrame()!;

    expect(frame).toContain('No matches');
    expect(frame).toContain('No items available');
    expect(frame).toContain('Esc to clear search');
  });

  it('shows custom empty message', () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} emptyMessage="Nothing here" />);

    expect(lastFrame()).toContain('Nothing here');
    expect(lastFrame()).not.toContain('No items available');
  });

  it('renders disabled items without cursor styling', () => {
    const disabledItems = [
      { id: 'a', title: 'Available' },
      { id: 'b', title: 'Disabled', disabled: true },
    ];

    // Select the disabled item (index 1)
    const { lastFrame } = render(<SelectList items={disabledItems} selectedIndex={1} />);
    const lines = lastFrame()!.split('\n');

    const disabledLine = lines.find(l => l.includes('Disabled'))!;
    // Cursor should still appear on the selected line even when disabled
    expect(disabledLine).toContain('❯');
    // Available line should not have cursor
    const availableLine = lines.find(l => l.includes('Available'))!;
    expect(availableLine).not.toContain('❯');
  });

  it('renders exactly one cursor across all items', () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);
    const lines = lastFrame()!.split('\n');
    const cursorCount = lines.filter(l => l.includes('❯')).length;

    expect(cursorCount).toBe(1);
  });
});
