import { useInput } from 'ink';
import { useState } from 'react';

interface UseListNavigationOptions<T> {
  /** The list of items to navigate */
  items: T[];
  /** Callback when an item is selected via Enter */
  onSelect?: (item: T, index: number) => void;
  /** Callback when Escape is pressed */
  onExit?: () => void;
  /** Whether navigation is active (default: true) */
  isActive?: boolean;
  /** Whether a text input is currently focused - disables j/k keys (default: false) */
  textInputActive?: boolean;
  /** Optional hotkey extractor - return hotkeys for an item */
  getHotkeys?: (item: T) => string[] | undefined;
  /** Callback when a hotkey matches an item */
  onHotkeySelect?: (item: T, index: number) => void;
  /** Optional function to check if an item is disabled */
  isDisabled?: (item: T) => boolean;
}

interface UseListNavigationResult {
  /** Current selected index */
  selectedIndex: number;
  /** Set the selected index */
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Reset selection to 0 */
  resetSelection: () => void;
}

/**
 * Hook for managing list navigation with arrow keys, Enter, Escape, and optional hotkeys.
 * Reduces boilerplate for screens with selectable lists.
 *
 * Note: Parent components should delay rendering until data is loaded to ensure
 * the initial selection is correct (return null during loading).
 *
 * @example
 * ```tsx
 * const { selectedIndex } = useListNavigation({
 *   items: commands,
 *   onSelect: (cmd) => handleCommand(cmd.id),
 *   onExit: () => goBack(),
 *   getHotkeys: (cmd) => cmd.hotkeys,
 *   onHotkeySelect: (cmd) => handleCommand(cmd.id),
 * });
 *
 * return <SelectList items={commands} selectedIndex={selectedIndex} />;
 * ```
 */
export function useListNavigation<T>({
  items,
  onSelect,
  onExit,
  isActive = true,
  textInputActive = false,
  getHotkeys,
  onHotkeySelect,
  isDisabled,
}: UseListNavigationOptions<T>): UseListNavigationResult {
  // Initialize with first enabled index (parent should ensure data is loaded before mounting)
  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (!isDisabled) return 0;
    const idx = items.findIndex(item => !isDisabled(item));
    return idx >= 0 ? idx : 0;
  });

  // Find next non-disabled index in given direction
  const findNextIndex = (current: number, direction: 1 | -1): number => {
    if (!isDisabled) {
      return (current + direction + items.length) % items.length;
    }
    let next = current;
    for (const _ of items) {
      next = (next + direction + items.length) % items.length;
      const item = items[next];
      if (item !== undefined && !isDisabled(item)) {
        return next;
      }
    }
    return current; // All items disabled, stay in place
  };

  useInput(
    (input, key) => {
      // Handle exit
      if (key.escape || input === 'q') {
        onExit?.();
        return;
      }

      // Handle arrow navigation (and j/k when no text input)
      if ((key.upArrow || (!textInputActive && input === 'k')) && items.length > 0) {
        setSelectedIndex(i => findNextIndex(i, -1));
        return;
      }

      if ((key.downArrow || (!textInputActive && input === 'j')) && items.length > 0) {
        setSelectedIndex(i => findNextIndex(i, 1));
        return;
      }

      // Handle Enter selection (skip if disabled)
      if (key.return && items[selectedIndex]) {
        if (isDisabled?.(items[selectedIndex])) {
          return; // Don't select disabled items
        }
        onSelect?.(items[selectedIndex], selectedIndex);
        return;
      }

      // Handle hotkey selection (skip if disabled)
      if (getHotkeys && onHotkeySelect) {
        const match = items.find(item => getHotkeys(item)?.includes(input.toLowerCase()) && !isDisabled?.(item));
        if (match) {
          const index = items.indexOf(match);
          onHotkeySelect(match, index);
        }
      }
    },
    { isActive }
  );

  const resetSelection = () => {
    if (isDisabled) {
      const firstEnabled = items.findIndex(item => !isDisabled(item));
      setSelectedIndex(firstEnabled >= 0 ? firstEnabled : 0);
    } else {
      setSelectedIndex(0);
    }
  };

  return { selectedIndex, setSelectedIndex, resetSelection };
}
