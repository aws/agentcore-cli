import { Box, Text } from 'ink';

export interface SelectableItem {
  id: string;
  title: string;
  description?: string;
  disabled?: boolean;
  /** Add a blank line before this item */
  spaceBefore?: boolean;
}

export function SelectList<T extends SelectableItem>(props: {
  items: T[];
  selectedIndex: number;
  emptyMessage?: string;
  /** Maximum number of visible items before scrolling. Undefined = show all. */
  maxVisibleItems?: number;
}) {
  if (props.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No matches</Text>
        <Text dimColor>{props.emptyMessage ?? 'No items available'}</Text>
        <Text dimColor>Esc to clear search</Text>
      </Box>
    );
  }

  const { items, selectedIndex, maxVisibleItems } = props;
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
        const selected = actualIndex === selectedIndex;
        const disabled = item.disabled ?? false;
        return (
          <Box key={item.id} marginTop={item.spaceBefore ? 1 : 0}>
            <Text wrap="wrap">
              <Text color={selected && !disabled ? 'cyan' : undefined} dimColor={disabled}>
                {selected ? '❯' : ' '}{' '}
              </Text>
              <Text color={selected && !disabled ? 'cyan' : undefined} dimColor={disabled}>
                {item.title}
              </Text>
              {item.description && <Text dimColor> - {item.description}</Text>}
            </Text>
          </Box>
        );
      })}
      {needsScroll && viewportEnd < items.length && <Text dimColor> ↓ {items.length - viewportEnd} more</Text>}
    </Box>
  );
}
