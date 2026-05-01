import { MultiSelectList } from './MultiSelectList';
import { SelectList, type SelectableItem } from './SelectList';
import { Box, Text } from 'ink';

interface WizardSelectBaseProps {
  /** Bold title displayed above the list */
  title: string;
  /** Optional dimmed description below the title */
  description?: string;
  /** Items to display */
  items: SelectableItem[];
  /** Message to show when items is empty */
  emptyMessage?: string;
}

interface WizardSelectProps extends WizardSelectBaseProps {
  /** Current selected index */
  selectedIndex: number;
  /** Maximum visible items before scrolling. Undefined = show all. */
  maxVisibleItems?: number;
}

interface WizardMultiSelectProps extends WizardSelectBaseProps {
  /** Current cursor index */
  cursorIndex: number;
  /** Currently selected item IDs */
  selectedIds: Set<string>;
  /** Maximum visible items before scrolling. Undefined = show all. */
  maxVisibleItems?: number;
}

/**
 * Styled single-select list for wizard steps.
 * Combines title, description, and SelectList.
 *
 * @example
 * ```tsx
 * <WizardSelect
 *   title="Select identity type"
 *   description="Choose the type of credential provider"
 *   items={typeItems}
 *   selectedIndex={typeNav.selectedIndex}
 * />
 * ```
 */
export function WizardSelect({
  title,
  description,
  items,
  selectedIndex,
  emptyMessage,
  maxVisibleItems,
}: WizardSelectProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {description && <Text dimColor>{description}</Text>}
      <Box marginTop={1}>
        <SelectList
          items={items}
          selectedIndex={selectedIndex}
          emptyMessage={emptyMessage}
          maxVisibleItems={maxVisibleItems}
        />
      </Box>
    </Box>
  );
}

/**
 * Styled multi-select list for wizard steps.
 * Combines title, description, and MultiSelectList.
 *
 * @example
 * ```tsx
 * <WizardMultiSelect
 *   title="Select agents to grant access"
 *   description="These agents can use the credentials"
 *   items={agentItems}
 *   cursorIndex={nav.cursorIndex}
 *   selectedIds={nav.selectedIds}
 * />
 * ```
 */
export function WizardMultiSelect({
  title,
  description,
  items,
  cursorIndex,
  selectedIds,
  emptyMessage,
  maxVisibleItems,
}: WizardMultiSelectProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {description && <Text dimColor>{description}</Text>}
      <Box marginTop={1}>
        <MultiSelectList
          items={items}
          selectedIndex={cursorIndex}
          selectedIds={selectedIds}
          emptyMessage={emptyMessage}
          maxVisibleItems={maxVisibleItems}
        />
      </Box>
    </Box>
  );
}
