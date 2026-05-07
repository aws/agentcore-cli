import { useInput } from 'ink';
import { useCallback, useState } from 'react';

export interface PanelPosition {
  column: 0 | 1;
  field: number;
  layer: 'focus' | 'active';
}

interface UsePanelNavigationOptions {
  /** Only capture input when the builder step is active */
  isActive: boolean;
  /** Number of fields per column */
  fieldCount: number;
  /** Called when Escape is pressed at the top-left origin */
  onExit: () => void;
  /** Optional check whether a field is disabled (non-focusable) */
  isFieldDisabled?: (column: number, field: number) => boolean;
  /** Optional check whether a field is auto-completed (skip on navigation) */
  isFieldAutoCompleted?: (column: number, field: number) => boolean;
  /** Called when the last field in the last column is completed */
  onComplete?: () => void;
}

interface UsePanelNavigationResult {
  position: PanelPosition;
  /** Whether the given field is the currently focused field */
  isFieldFocused: (column: number, field: number) => boolean;
  /** Whether the given field has its picker/input open */
  isFieldActive: (column: number, field: number) => boolean;
  /** Whether the given column is the active column */
  isColumnActive: (column: number) => boolean;
  /** Open the picker/input for the currently focused field */
  activate: () => void;
  /** Close the picker/input, returning to field focus */
  deactivate: () => void;
  /** Move focus to a specific field */
  moveToField: (column: number, field: number) => void;
}

/**
 * 2D focus management hook for a side-by-side panel builder.
 *
 * Navigation model:
 * - Tab switches columns (0 <-> 1)
 * - Up/Down moves between fields within the active column
 * - Enter activates the focused field (layer -> 'active')
 * - Escape deactivates or navigates back
 *
 * When layer === 'active', the hook yields input to child components
 * by setting its own `useInput` to inactive.
 */
export function usePanelNavigation({
  isActive,
  fieldCount,
  onExit,
  isFieldDisabled,
  isFieldAutoCompleted: _isFieldAutoCompleted,
  onComplete,
}: UsePanelNavigationOptions): UsePanelNavigationResult {
  const [position, setPosition] = useState<PanelPosition>({
    column: 0,
    field: 0,
    layer: 'focus',
  });

  // Only handle input when at focus layer and the panel is active
  const inputActive = isActive && position.layer === 'focus';

  useInput(
    (input, key) => {
      // Tab: switch columns
      if (key.tab) {
        setPosition(p => ({
          ...p,
          column: p.column === 0 ? 1 : 0,
        }));
        return;
      }

      // Up: move to previous field
      if (key.upArrow) {
        setPosition(p => {
          let next = p.field - 1;
          // Skip disabled fields going up
          while (next >= 0 && isFieldDisabled?.(p.column, next)) {
            next--;
          }
          if (next < 0) return p;
          return { ...p, field: next };
        });
        return;
      }

      // Down: move to next field
      if (key.downArrow) {
        setPosition(p => {
          let next = p.field + 1;
          // Skip disabled fields going down
          while (next < fieldCount && isFieldDisabled?.(p.column, next)) {
            next++;
          }
          if (next >= fieldCount) return p;
          return { ...p, field: next };
        });
        return;
      }

      // Enter: always activate the focused field (open picker)
      if (key.return) {
        setPosition(p => ({ ...p, layer: 'active' }));
        return;
      }

      // Escape: navigate back through the hierarchy
      if (key.escape) {
        setPosition(p => {
          // If not at field 0, go to field 0 in same column
          if (p.field > 0) {
            return { ...p, field: 0 };
          }
          // If at field 0 but not column 0, go to column 0
          if (p.column > 0) {
            return { ...p, column: 0 };
          }
          // At origin: exit
          onExit();
          return p;
        });
        return;
      }
    },
    { isActive: inputActive }
  );

  const isFieldFocused = useCallback(
    (column: number, field: number): boolean => {
      return position.column === column && position.field === field && position.layer === 'focus';
    },
    [position]
  );

  const isFieldActive = useCallback(
    (column: number, field: number): boolean => {
      return position.column === column && position.field === field && position.layer === 'active';
    },
    [position]
  );

  const isColumnActive = useCallback(
    (column: number): boolean => {
      return position.column === column;
    },
    [position.column]
  );

  const activate = useCallback(() => {
    setPosition(p => ({ ...p, layer: 'active' }));
  }, []);

  const deactivate = useCallback(() => {
    setPosition(p => {
      // After a selection, advance to the next field in sequence:
      // column 0 fields 0→1→2, then column 1 fields 0→1→2, then complete
      const nextField = p.field + 1;
      if (nextField < fieldCount) {
        // Next field in same column
        return { column: p.column, field: nextField, layer: 'focus' };
      }
      if (p.column === 0) {
        // Finished left column → move to right column field 0
        return { column: 1, field: 0, layer: 'focus' };
      }
      // Finished last field in right column → stay and let onComplete handle it
      if (onComplete) {
        // Use setTimeout to avoid setState during render
        setTimeout(onComplete, 0);
      }
      return { ...p, layer: 'focus' };
    });
  }, [fieldCount, onComplete]);

  const moveToField = useCallback((column: number, field: number) => {
    setPosition({ column: column as 0 | 1, field, layer: 'focus' });
  }, []);

  return {
    position,
    isFieldFocused,
    isFieldActive,
    isColumnActive,
    activate,
    deactivate,
    moveToField,
  };
}
