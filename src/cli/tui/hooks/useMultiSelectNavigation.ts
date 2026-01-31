import { useInput } from 'ink';
import { useCallback, useState } from 'react';

interface UseMultiSelectNavigationOptions<T> {
  /** The list of items to navigate */
  items: T[];
  /** Extract item ID for selection tracking */
  getId: (item: T) => string;
  /** Callback when selection is confirmed via Enter */
  onConfirm?: (selectedIds: string[]) => void;
  /** Callback when Escape is pressed */
  onExit?: () => void;
  /** Whether navigation is active (default: true) */
  isActive?: boolean;
  /** Whether a text input is currently focused - disables j/k keys (default: false) */
  textInputActive?: boolean;
  /** Whether to require at least one selection before confirm (default: false) */
  requireSelection?: boolean;
}

interface UseMultiSelectNavigationResult {
  /** Current cursor index */
  cursorIndex: number;
  /** Set the cursor index */
  setCursorIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Currently selected item IDs */
  selectedIds: Set<string>;
  /** Toggle selection of item at cursor */
  toggleSelection: () => void;
  /** Reset cursor and selection */
  reset: () => void;
}

/**
 * Hook for managing multi-select list navigation with arrow keys, Space toggle, Enter confirm, Escape exit.
 * Reduces boilerplate for screens with multi-selectable lists.
 *
 * @example
 * ```tsx
 * const { cursorIndex, selectedIds } = useMultiSelectNavigation({
 *   items: agents,
 *   getId: (agent) => agent.name,
 *   onConfirm: (ids) => wizard.setAgents(ids),
 *   onExit: () => wizard.goBack(),
 *   isActive: wizard.step === 'agents',
 * });
 *
 * return <MultiSelectList items={agents} selectedIndex={cursorIndex} selectedIds={selectedIds} />;
 * ```
 */
export function useMultiSelectNavigation<T>({
  items,
  getId,
  onConfirm,
  onExit,
  isActive = true,
  textInputActive = false,
  requireSelection = false,
}: UseMultiSelectNavigationOptions<T>): UseMultiSelectNavigationResult {
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback(() => {
    const item = items[cursorIndex];
    if (!item) return;
    const id = getId(item);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [items, cursorIndex, getId]);

  const reset = useCallback(() => {
    setCursorIndex(0);
    setSelectedIds(new Set());
  }, []);

  useInput(
    (input, key) => {
      // Handle exit
      if (key.escape) {
        onExit?.();
        return;
      }

      // Handle arrow navigation (and j/k when no text input)
      if ((key.upArrow || (!textInputActive && input === 'k')) && items.length > 0) {
        setCursorIndex(i => Math.max(0, i - 1));
        return;
      }

      if ((key.downArrow || (!textInputActive && input === 'j')) && items.length > 0) {
        setCursorIndex(i => Math.min(items.length - 1, i + 1));
        return;
      }

      // Handle Space toggle
      if (input === ' ' && items.length > 0) {
        toggleSelection();
        return;
      }

      // Handle Enter confirm
      if (key.return) {
        if (requireSelection && selectedIds.size === 0) {
          return; // Don't confirm if selection required but none selected
        }
        onConfirm?.(Array.from(selectedIds));
      }
    },
    { isActive }
  );

  return { cursorIndex, setCursorIndex, selectedIds, toggleSelection, reset };
}
