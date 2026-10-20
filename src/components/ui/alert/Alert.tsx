import React from "react";
import { Box, Text } from "ink";
import { darkTheme, glyphs, type InkUITheme } from "../_core.js";

export interface AlertProps {
  children: React.ReactNode;
  theme?: InkUITheme;
  variant?: "info" | "warning";
}

/**
 * Compact callout for inline TUI guidance.
 */
export function Alert({ children, theme = darkTheme, variant = "info" }: AlertProps) {
  const color = variant === "warning" ? theme.colors.warning : theme.colors.secondary;
  const glyph = variant === "warning" ? glyphs.warning : glyphs.info;

  return (
    <Box alignSelf="flex-start" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color}>{glyph} </Text>
      <Text color={theme.colors.text}>{children}</Text>
    </Box>
  );
}
