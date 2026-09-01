import React from "react";
import { Text, Box, useStdout } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export type DividerStyle = "single" | "double" | "dashed" | "bold";

export interface DividerProps {
  title?: string;
  style?: DividerStyle;
  /** Defaults to terminal width */
  width?: number;
  theme?: InkUITheme;
}

const CHARS: Record<DividerStyle, string> = {
  single: "─",
  double: "═",
  dashed: "╌",
  bold: "━",
};

export const Divider: React.FC<DividerProps> = ({
  title,
  style = "single",
  width,
  theme = darkTheme,
}) => {
  const { stdout } = useStdout();
  const totalWidth = width ?? stdout?.columns ?? 80;
  const char = CHARS[style];

  let line: string;

  if (title) {
    // ── Title ───────────────────────
    const prefix = char + char + " ";
    const suffix = " ";
    const remaining = totalWidth - prefix.length - title.length - suffix.length;
    line = prefix + title + suffix + char.repeat(Math.max(0, remaining));
  } else {
    line = char.repeat(totalWidth);
  }

  return (
    <Box flexShrink={0}>
      <Text color={theme.colors.border}>{line}</Text>
    </Box>
  );
};
