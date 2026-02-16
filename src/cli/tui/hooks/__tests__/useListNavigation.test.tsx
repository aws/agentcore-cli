import { findNextEnabledIndex, useListNavigation } from '../useListNavigation.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UP_ARROW = '\x1B[A';
const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

describe('findNextEnabledIndex', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  describe('without isDisabled', () => {
    it('moves forward by 1', () => {
      expect(findNextEnabledIndex(items, 0, 1)).toBe(1);
      expect(findNextEnabledIndex(items, 2, 1)).toBe(3);
    });

    it('moves backward by 1', () => {
      expect(findNextEnabledIndex(items, 2, -1)).toBe(1);
      expect(findNextEnabledIndex(items, 1, -1)).toBe(0);
    });

    it('wraps forward from last to first', () => {
      expect(findNextEnabledIndex(items, 4, 1)).toBe(0);
    });

    it('wraps backward from first to last', () => {
      expect(findNextEnabledIndex(items, 0, -1)).toBe(4);
    });
  });

  describe('with isDisabled', () => {
    const isDisabled = (item: string) => item === 'b' || item === 'd';

    it('skips disabled items going forward', () => {
      expect(findNextEnabledIndex(items, 0, 1, isDisabled)).toBe(2);
    });

    it('skips disabled items going backward', () => {
      expect(findNextEnabledIndex(items, 2, -1, isDisabled)).toBe(0);
    });

    it('skips multiple consecutive disabled items', () => {
      const allItems = ['a', 'b', 'c', 'd', 'e'];
      const skip = (item: string) => item === 'b' || item === 'c';
      expect(findNextEnabledIndex(allItems, 0, 1, skip)).toBe(3);
    });

    it('wraps around to find enabled item', () => {
      expect(findNextEnabledIndex(items, 4, 1, isDisabled)).toBe(0);
    });

    it('stays in place when all items are disabled', () => {
      const allDisabled = (_item: string) => true;
      expect(findNextEnabledIndex(items, 2, 1, allDisabled)).toBe(2);
      expect(findNextEnabledIndex(items, 2, -1, allDisabled)).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles single-item list', () => {
      expect(findNextEnabledIndex(['only'], 0, 1)).toBe(0);
      expect(findNextEnabledIndex(['only'], 0, -1)).toBe(0);
    });

    it('handles two-item list', () => {
      expect(findNextEnabledIndex(['a', 'b'], 0, 1)).toBe(1);
      expect(findNextEnabledIndex(['a', 'b'], 1, 1)).toBe(0);
    });
  });
});

// Wrapper component to test the hook via rendering
function ListNav({
  items,
  onSelect,
  onExit,
  isDisabled,
  getHotkeys,
  onHotkeySelect,
}: {
  items: string[];
  onSelect?: (item: string, index: number) => void;
  onExit?: () => void;
  isDisabled?: (item: string) => boolean;
  getHotkeys?: (item: string) => string[] | undefined;
  onHotkeySelect?: (item: string, index: number) => void;
}) {
  const { selectedIndex } = useListNavigation({
    items,
    onSelect,
    onExit,
    isDisabled,
    getHotkeys,
    onHotkeySelect,
  });
  return <Text>idx:{selectedIndex}</Text>;
}

describe('useListNavigation hook', () => {
  const items = ['alpha', 'beta', 'gamma'];

  it('starts at index 0', () => {
    const { lastFrame } = render(<ListNav items={items} />);
    expect(lastFrame()).toContain('idx:0');
  });

  it('moves down with arrow key', async () => {
    const { lastFrame, stdin } = render(<ListNav items={items} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:1');
  });

  it('moves up with arrow key', async () => {
    const { lastFrame, stdin } = render(<ListNav items={items} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:2');

    stdin.write(UP_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:1');
  });

  it('wraps around when navigating past the end', async () => {
    const { lastFrame, stdin } = render(<ListNav items={items} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW); // wraps to 0
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:0');
  });

  it('calls onSelect on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ListNav items={items} onSelect={onSelect} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSelect).toHaveBeenCalledWith('alpha', 0);
  });

  it('calls onSelect with correct item after navigation', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ListNav items={items} onSelect={onSelect} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSelect).toHaveBeenCalledWith('beta', 1);
  });

  it('calls onExit on Escape', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<ListNav items={items} onExit={onExit} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('skips disabled items during navigation', async () => {
    const isDisabled = (item: string) => item === 'beta';
    const { lastFrame, stdin } = render(<ListNav items={items} isDisabled={isDisabled} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW); // should skip beta (1) and land on gamma (2)
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:2');
  });

  it('does not select disabled items on Enter', async () => {
    // When all items are disabled, the hook starts at index 0 and Enter should not call onSelect
    const isDisabled = () => true;
    const onSelect = vi.fn();
    const { stdin } = render(<ListNav items={items} onSelect={onSelect} isDisabled={isDisabled} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('supports hotkey selection', async () => {
    const onHotkeySelect = vi.fn();
    const getHotkeys = (item: string) => (item === 'gamma' ? ['g'] : undefined);
    const { stdin } = render(<ListNav items={items} getHotkeys={getHotkeys} onHotkeySelect={onHotkeySelect} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('g');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onHotkeySelect).toHaveBeenCalledWith('gamma', 2);
  });

  it('navigates with j/k keys', async () => {
    const { lastFrame, stdin } = render(<ListNav items={items} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('j'); // down
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:1');

    stdin.write('k'); // up
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(lastFrame()).toContain('idx:0');
  });
});
