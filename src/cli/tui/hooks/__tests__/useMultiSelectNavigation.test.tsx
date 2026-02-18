import { useMultiSelectNavigation } from '../useMultiSelectNavigation.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UP_ARROW = '\x1B[A';
const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const ESCAPE = '\x1B';
const SPACE = ' ';

const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => vi.restoreAllMocks());

interface Item {
  id: string;
  name: string;
}

const items: Item[] = [
  { id: '1', name: 'alpha' },
  { id: '2', name: 'beta' },
  { id: '3', name: 'gamma' },
];

const getId = (item: Item) => item.id;

function Harness({
  testItems = items,
  onConfirm,
  onExit,
  isActive,
  textInputActive,
  requireSelection,
}: {
  testItems?: Item[];
  onConfirm?: (ids: string[]) => void;
  onExit?: () => void;
  isActive?: boolean;
  textInputActive?: boolean;
  requireSelection?: boolean;
}) {
  const { cursorIndex, selectedIds } = useMultiSelectNavigation({
    items: testItems,
    getId,
    onConfirm,
    onExit,
    isActive,
    textInputActive,
    requireSelection,
  });
  return (
    <Text>
      cursor:{cursorIndex} selected:{Array.from(selectedIds).sort().join(',')}
    </Text>
  );
}

describe('useMultiSelectNavigation', () => {
  it('starts with cursorIndex=0 and empty selectedIds', () => {
    const { lastFrame } = render(<Harness />);
    expect(lastFrame()).toContain('cursor:0');
    expect(lastFrame()).toContain('selected:');
    // Ensure no ids are selected (selected: is followed by nothing meaningful)
    expect(lastFrame()).not.toMatch(/selected:\S/);
  });

  it('arrow down moves cursor', async () => {
    const { lastFrame, stdin } = render(<Harness />);
    await delay();
    stdin.write(DOWN_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:1');

    stdin.write(DOWN_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:2');
  });

  it('arrow up moves cursor', async () => {
    const { lastFrame, stdin } = render(<Harness />);
    await delay();
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:2');

    stdin.write(UP_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:1');
  });

  it('cursor does not go below 0', async () => {
    const { lastFrame, stdin } = render(<Harness />);
    await delay();
    stdin.write(UP_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:0');
  });

  it('cursor does not go past items.length-1', async () => {
    const { lastFrame, stdin } = render(<Harness />);
    await delay();
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:2');
  });

  it('j/k keys navigate when textInputActive=false', async () => {
    const { lastFrame, stdin } = render(<Harness textInputActive={false} />);
    await delay();
    stdin.write('j');
    await delay();
    expect(lastFrame()).toContain('cursor:1');

    stdin.write('k');
    await delay();
    expect(lastFrame()).toContain('cursor:0');
  });

  it('j/k keys do NOT navigate when textInputActive=true', async () => {
    const { lastFrame, stdin } = render(<Harness textInputActive={true} />);
    await delay();
    stdin.write('j');
    await delay();
    expect(lastFrame()).toContain('cursor:0');

    stdin.write('k');
    await delay();
    expect(lastFrame()).toContain('cursor:0');
  });

  it('space toggles selection (add then remove)', async () => {
    const { lastFrame, stdin } = render(<Harness />);
    await delay();
    // Select item at cursor 0 (id '1')
    stdin.write(SPACE);
    await delay();
    expect(lastFrame()).toContain('selected:1');

    // Toggle again to deselect
    stdin.write(SPACE);
    await delay();
    expect(lastFrame()).not.toMatch(/selected:\S/);
  });

  it('enter calls onConfirm with selected IDs', async () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<Harness onConfirm={onConfirm} />);
    await delay();

    // Select first item
    stdin.write(SPACE);
    await delay();

    // Move down and select second item
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(SPACE);
    await delay();

    // Confirm
    stdin.write(ENTER);
    await delay();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const calledWith = onConfirm.mock.calls[0]![0] as string[];
    expect(calledWith.sort()).toEqual(['1', '2']);
  });

  it('enter does nothing when requireSelection=true and nothing selected', async () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<Harness onConfirm={onConfirm} requireSelection={true} />);
    await delay();

    stdin.write(ENTER);
    await delay();

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('escape calls onExit', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<Harness onExit={onExit} />);
    await delay();

    stdin.write(ESCAPE);
    await delay();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not respond when isActive=false', async () => {
    const onConfirm = vi.fn();
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(<Harness isActive={false} onConfirm={onConfirm} onExit={onExit} />);
    await delay();

    stdin.write(DOWN_ARROW);
    await delay();
    expect(lastFrame()).toContain('cursor:0');

    stdin.write(SPACE);
    await delay();
    expect(lastFrame()).not.toMatch(/selected:\S/);

    stdin.write(ENTER);
    await delay();
    expect(onConfirm).not.toHaveBeenCalled();

    stdin.write(ESCAPE);
    await delay();
    expect(onExit).not.toHaveBeenCalled();
  });
});
