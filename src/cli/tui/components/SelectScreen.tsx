import { HELP_TEXT } from '../constants';
import { useListNavigation } from '../hooks';
import { Panel } from './Panel';
import { Screen } from './Screen';
import { SelectList, type SelectableItem } from './SelectList';
import type { ReactNode } from 'react';

interface SelectScreenProps<T extends SelectableItem> {
  /** Screen title */
  title: string;
  /** Title color (default: cyan) */
  color?: string;
  /** Optional header content below the title */
  headerContent?: ReactNode;
  /** Optional custom help text (default: HELP_TEXT.NAVIGATE_SELECT) */
  helpText?: string;
  /** Items to display in the list */
  items: T[];
  /** Called when an item is selected */
  onSelect: (item: T, index: number) => void;
  /** Called when exiting (Escape or Ctrl+Q) */
  onExit: () => void;
  /** Whether navigation is active (default: true) */
  isActive?: boolean;
  /** Optional hotkey extractor */
  getHotkeys?: (item: T) => string[] | undefined;
  /** Message to show when items is empty */
  emptyMessage?: string;
  /** Optional content to render below the list */
  children?: ReactNode;
  /** Optional function to check if an item is disabled */
  isDisabled?: (item: T) => boolean;
}

/**
 * A complete screen for simple selection lists.
 * Combines Screen, Panel, SelectList, and useListNavigation.
 *
 * @example
 * ```tsx
 * <SelectScreen
 *   title="Add Resource"
 *   items={RESOURCES}
 *   onSelect={(item) => handleAdd(item.id)}
 *   onExit={goBack}
 * />
 * ```
 */
export function SelectScreen<T extends SelectableItem>({
  title,
  color,
  headerContent,
  helpText = HELP_TEXT.NAVIGATE_SELECT,
  items,
  onSelect,
  onExit,
  isActive = true,
  getHotkeys,
  emptyMessage,
  children,
  isDisabled,
}: SelectScreenProps<T>) {
  const { selectedIndex } = useListNavigation({
    items,
    onSelect,
    onExit,
    isActive,
    getHotkeys,
    onHotkeySelect: onSelect,
    isDisabled,
  });

  return (
    <Screen title={title} color={color} onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        <SelectList items={items} selectedIndex={selectedIndex} emptyMessage={emptyMessage} />
      </Panel>
      {children}
    </Screen>
  );
}
