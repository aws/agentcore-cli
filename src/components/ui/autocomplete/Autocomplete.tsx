import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface AutocompleteItem<T = string> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean;
}

export interface AutocompleteProps<T = string> {
  items: AutocompleteItem<T>[];
  onSelect: (item: AutocompleteItem<T>) => void;
  placeholder?: string;
  label?: string;
  maxVisible?: number;
  filter?: (query: string, item: AutocompleteItem<T>) => boolean;
  showDescriptions?: boolean;
  emptyMessage?: string;
  focus?: boolean;
  theme?: InkUITheme;
}

export function Autocomplete<T = string>({
  items,
  onSelect,
  placeholder = "Search...",
  label,
  maxVisible = 5,
  filter,
  showDescriptions = true,
  emptyMessage = "No matches",
  focus = true,
  theme = darkTheme,
}: AutocompleteProps<T>): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const defaultFilter = (q: string, item: AutocompleteItem<T>) =>
    item.label.toLowerCase().includes(q.toLowerCase());

  const filterFn = filter ?? defaultFilter;
  const filtered = items.filter(
    (item) => !item.disabled && (query === "" || filterFn(query, item)),
  );
  const visible = filtered.slice(0, maxVisible);

  useInput(
    (input, key) => {
      if (key.escape) {
        setQuery("");
        setHighlightIndex(0);
        return;
      }
      if (key.upArrow) {
        setHighlightIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setHighlightIndex((i) => Math.min(visible.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const item = visible[highlightIndex];
        if (item) {
          onSelect(item);
          setQuery("");
          setHighlightIndex(0);
        }
        return;
      }
      if (key.tab) {
        const item = visible[highlightIndex];
        if (item) setQuery(item.label);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setHighlightIndex(0);
        return;
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setHighlightIndex(0);
      }
    },
    { isActive: focus },
  );

  return (
    <Box flexDirection="column">
      {/* Input */}
      <Box>
        {label && <Text color={theme.colors.muted}>{label} </Text>}
        <Text color={theme.colors.primary}>{glyphs.pointer} </Text>
        <Text color={theme.colors.text}>
          {query || <Text color={theme.colors.muted}>{placeholder}</Text>}
        </Text>
        {focus && <Text color={theme.colors.primary}>█</Text>}
      </Box>

      {/* Dropdown */}
      {focus && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.colors.border}
          marginLeft={2}
        >
          {visible.length === 0 ? (
            <Box paddingX={1}>
              <Text color={theme.colors.muted}>{emptyMessage}</Text>
            </Box>
          ) : (
            visible.map((item, i) => {
              const isHl = i === highlightIndex;
              return (
                <Box key={String(item.value)} paddingX={1} flexDirection="row" gap={1}>
                  <Text color={isHl ? theme.colors.primary : theme.colors.muted}>
                    {isHl ? glyphs.pointer : " "}
                  </Text>
                  <Text bold={isHl} color={isHl ? theme.colors.primary : theme.colors.text}>
                    {item.label}
                  </Text>
                  {showDescriptions && item.description && (
                    <Text color={theme.colors.muted}>{item.description}</Text>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      )}
    </Box>
  );
}
