import React from "react";
import { Text, Box, Spacer, useWindowSize } from "ink";
import stringWidth from "string-width";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

const ITEM_GAP = 2;

export interface KeyHintItem {
  /** Displayed in brackets, e.g. "Enter", "↑↓", "Space" */
  key: string;
  /** Description label, e.g. "Select", "Navigate", "Toggle" */
  label: string;
}

export interface KeyHintProps {
  keys: KeyHintItem[];
  theme?: InkUITheme;
}

function priority({ key, label }: KeyHintItem): number {
  if (key === "esc" || label === "back") return 0;
  if (key === "enter" || key.includes(glyphs.enter) || label === "select") return 1;
  if (key.includes("↑") || key.includes("↓")) return 2;
  if (key.includes("←") || key.includes("→") || key === "/") return 4;
  return 3;
}

function itemWidth({ key, label }: KeyHintItem): number {
  return stringWidth(`[${key}] ${label}`);
}

function fitKeys(keys: KeyHintItem[], columns: number): KeyHintItem[] {
  const candidates = keys
    .map((item, index) => ({ item, index }))
    .sort((a, b) => priority(a.item) - priority(b.item) || a.index - b.index);
  const selected = new Set<number>();
  let width = 0;

  for (const candidate of candidates) {
    const nextWidth = itemWidth(candidate.item) + (selected.size === 0 ? 0 : ITEM_GAP);
    if (width + nextWidth > columns) continue;
    selected.add(candidate.index);
    width += nextWidth;
  }

  return keys.filter((_, index) => selected.has(index));
}

// ctrl+c quits on every screen (Ink's exitOnCtrlC), so KeyHint owns its hint and
// pins it to the right edge; a key that's always available then never moves.
const QUIT: KeyHintItem = { key: "ctrl+c", label: "quit" };

export const KeyHint: React.FC<KeyHintProps> = ({ keys, theme = darkTheme }) => {
  const { columns } = useWindowSize();
  const screenKeys = keys.filter((k) => k.key !== QUIT.key);
  // Reserve QUIT's width so it's never the hint fitKeys drops.
  const room = columns - itemWidth(QUIT) - ITEM_GAP;

  return (
    <Box width={columns} height={1} overflow="hidden" gap={ITEM_GAP}>
      {fitKeys(screenKeys, room).map((item) => (
        <Hint key={item.key} item={item} theme={theme} />
      ))}
      <Spacer />
      <Hint item={QUIT} theme={theme} />
    </Box>
  );
};

// Takes `item` rather than spread props because React reserves `key`.
const Hint: React.FC<{ item: KeyHintItem; theme: InkUITheme }> = ({ item, theme }) => (
  <Box flexShrink={0} gap={1}>
    <Text bold dimColor>
      [{item.key}]
    </Text>
    <Text color={theme.colors.muted}>{item.label}</Text>
  </Box>
);
