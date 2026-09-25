import { Box, Text } from "ink";
import stringWidth from "string-width";

import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export type KeyValueRow = readonly [key: string, value: string];

export interface KeyValueSection {
  readonly title?: string;
  readonly rows: readonly KeyValueRow[];
}

export type KeyValueTableProps =
  | { items: Readonly<Record<string, string>>; sections?: never }
  | { sections: readonly KeyValueSection[]; items?: never };

// The key column takes at most this share of the table, so a long key (an
// option with a long placeholder, say) leaves room for its value to wrap
// legibly instead of squeezing it into the margin. The gap is inside the
// column, so a key that fills the cap still stands clear of its value. Capped
// by layout rather than by reading the terminal width: a resize re-lays out
// without re-rendering, so a width computed in render would go stale.
const MAX_KEY_SHARE = "50%";
const GAP = 2;

export function KeyValueTable(props: KeyValueTableProps) {
  const input: readonly KeyValueSection[] =
    props.items !== undefined ? [{ rows: Object.entries(props.items) }] : props.sections;
  const sections = input.filter((section) => section.rows.length > 0);
  if (sections.length === 0) return null;

  const hasHeadings = sections.some((section) => Boolean(section.title));
  const longestKeyWidth = sections
    .flatMap((section) => section.rows)
    .reduce((max, [key]) => Math.max(max, ...key.split("\n").map((line) => stringWidth(line))), 0);

  // Two boxes rather than one padded string, so a value that wraps continues
  // under itself, not under the key.
  return (
    <Box width="100%" flexDirection="column">
      {sections.map((section, sectionIndex) => (
        <Box key={sectionIndex} flexDirection="column" marginTop={section.title ? 1 : 0}>
          {section.title && <Text color={theme.colors.text}>{section.title}</Text>}
          <Box paddingLeft={hasHeadings ? 2 : 0} flexDirection="column">
            {section.rows.map(([key, value], rowIndex) => (
              <Box key={rowIndex}>
                <Box
                  width={longestKeyWidth + GAP}
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
        </Box>
      ))}
    </Box>
  );
}
