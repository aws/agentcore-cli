import { Box, Text } from "ink";

import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface KeyValueTableProps {
  items: Record<string, string>;
}

// The key column takes at most this share of the table, so a long key (an
// option with a long placeholder, say) leaves room for its value to wrap
// legibly instead of squeezing it into the margin. The gap is inside the
// column, so a key that fills the cap still stands clear of its value. Capped
// by layout rather than by reading the terminal width: a resize re-lays out
// without re-rendering, so a width computed in render would go stale.
const MAX_KEY_SHARE = "50%";
const GAP = 2;

export function KeyValueTable({ items }: KeyValueTableProps) {
  const longestKeyLen = Object.keys(items).reduce((max, key) => Math.max(max, key.length), 0);

  // Two boxes rather than one padded string, so a value that wraps continues
  // under itself, not under the key.
  return (
    <Box flexDirection="column">
      {Object.entries(items).map(([key, value]) => (
        <Box key={key}>
          <Box
            width={longestKeyLen + GAP}
            maxWidth={MAX_KEY_SHARE}
            flexShrink={0}
            paddingRight={GAP}
          >
            <Text color={theme.colors.muted}>{key}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={theme.colors.text}>{value}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
