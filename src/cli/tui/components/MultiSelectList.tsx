import type { SelectableItem } from './SelectList';
import { Box, Text } from 'ink';

export interface MultiSelectListProps<T extends SelectableItem> {
  items: T[];
  selectedIndex: number;
  selectedIds: Set<string>;
  emptyMessage?: string;
  /** Maximum number of visible items before scrolling. Undefined = show all. */
  maxVisibleItems?: number;
}

export function MultiSelectList<T extends SelectableItem>(props: MultiSelectListProps<T>) {
  if (props.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No agents found</Text>
        <Text dimColor>{props.emptyMessage ?? 'No agents available in agentcore.json'}</Text>
      </Box>
    );
  }

  const { items, selectedIndex, selectedIds, maxVisibleItems } = props;
  const needsScroll = maxVisibleItems !== undefined && items.length > maxVisibleItems;

  let visibleItems = items;
  let viewportStart = 0;
  let viewportEnd = items.length;

  if (needsScroll) {
    const halfVisible = Math.floor(maxVisibleItems / 2);
    viewportStart = Math.max(0, selectedIndex - halfVisible);
    viewportEnd = Math.min(items.length, viewportStart + maxVisibleItems);
    if (viewportEnd - viewportStart < maxVisibleItems) {
      viewportStart = Math.max(0, viewportEnd - maxVisibleItems);
    }
    visibleItems = items.slice(viewportStart, viewportEnd);
  }

  return (
    <Box flexDirection="column">
      {needsScroll && viewportStart > 0 && <Text dimColor> ↑ {viewportStart} more</Text>}
      {visibleItems.map((item, idx) => {
        const actualIndex = viewportStart + idx;
        const isCursor = actualIndex === selectedIndex;
        const isChecked = selectedIds.has(item.id);
        const checkbox = isChecked ? '[✓]' : '[ ]';
        return (
          <Box key={item.id}>
            <Text wrap="truncate">
              <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '❯' : ' '} </Text>
              <Text color={isChecked ? 'green' : undefined}>{checkbox} </Text>
              <Text color={isCursor ? 'cyan' : undefined}>{item.title}</Text>
              {item.description && <Text dimColor> - {item.description}</Text>}
            </Text>
          </Box>
        );
      })}
      {needsScroll && viewportEnd < items.length && <Text dimColor> ↓ {items.length - viewportEnd} more</Text>}
    </Box>
  );
}
