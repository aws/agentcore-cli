import React, { useState } from "react";
import { Box, Text, useInput, useApp, useStdin } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface SelectItem<T = string> {
  label: string;
  value: T;
  disabled?: boolean;
}

export interface SelectProps<T = string> {
  /** List of options */
  items: SelectItem<T>[];
  /** Called when the user presses Enter on an enabled item */
  onSelect: (item: SelectItem<T>) => void;
  /** Value highlighted when the select mounts */
  initialValue?: T;
  /** Whether this select captures keyboard input */
  focus?: boolean;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
}

// ─── shared list display ─────────────────────────────────────────────────────

interface ListDisplayProps<T> {
  items: SelectItem<T>[];
  activeIndex: number;
  isFocused: boolean;
  theme: InkUITheme;
}

function ListDisplay<T>({ items, activeIndex, isFocused, theme }: ListDisplayProps<T>) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const isActive = i === activeIndex;
        const isDisabled = item.disabled === true;

        let labelColor: string;
        if (isDisabled) {
          labelColor = theme.colors.muted;
        } else if (isActive && isFocused) {
          labelColor = theme.colors.focus;
        } else {
          labelColor = theme.colors.text;
        }

        const indicator = isActive && isFocused ? "❯ " : "  ";

        return (
          <Box key={String(item.value)}>
            <Text color={isActive && isFocused ? theme.colors.focus : theme.colors.muted}>
              {indicator}
            </Text>
            <Text color={labelColor} dimColor={isDisabled}>
              {item.label}
            </Text>
            {isDisabled ? <Text color={theme.colors.muted}>{" (disabled)"}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

// ─── focused inner (only mounts when raw mode is available) ──────────────────

interface FocusedSelectProps<T> {
  items: SelectItem<T>[];
  onSelect: (item: SelectItem<T>) => void;
  initialValue?: T;
  theme: InkUITheme;
}

function FocusedSelect<T>({ items, onSelect, initialValue, theme }: FocusedSelectProps<T>) {
  const { exit } = useApp();

  const firstEnabled = items.findIndex((it) => !it.disabled);
  const initialIndex = items.findIndex((it) => !it.disabled && Object.is(it.value, initialValue));
  const [index, setIndex] = useState(Math.max(0, initialIndex >= 0 ? initialIndex : firstEnabled));

  const move = (dir: 1 | -1) => {
    setIndex((prev) => {
      let next = prev + dir;
      // Wrap around, skip disabled
      for (let i = 0; i < items.length; i++) {
        const wrapped = ((next % items.length) + items.length) % items.length;
        if (!items[wrapped]!.disabled) return wrapped;
        next += dir;
      }
      return prev; // all disabled — stay put
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.return) {
      const item = items[index];
      if (item && !item.disabled) onSelect(item);
      return;
    }
  });

  return <ListDisplay items={items} activeIndex={index} isFocused theme={theme} />;
}

// ─── public component ─────────────────────────────────────────────────────────

export function Select<T = string>({
  items,
  onSelect,
  initialValue,
  focus = true,
  theme = darkTheme,
}: SelectProps<T>) {
  const { isRawModeSupported } = useStdin();
  const canFocus = focus && isRawModeSupported;

  if (canFocus) {
    return (
      <FocusedSelect items={items} onSelect={onSelect} initialValue={initialValue} theme={theme} />
    );
  }

  const initialIndex = items.findIndex((it) => !it.disabled && Object.is(it.value, initialValue));
  const firstEnabled = items.findIndex((it) => !it.disabled);
  const activeIndex = Math.max(0, initialIndex >= 0 ? initialIndex : firstEnabled);
  return <ListDisplay items={items} activeIndex={activeIndex} isFocused={false} theme={theme} />;
}
