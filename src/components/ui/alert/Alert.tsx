import React from "react";
import { Box, Text } from "ink";
import { darkTheme, glyphs, type InkUITheme } from "../_core.js";

export interface AlertProps {
  children: React.ReactNode;
  theme?: InkUITheme;
}

/**
 * Compact informational callout for inline TUI guidance.
 */
export function Alert({ children, theme = darkTheme }: AlertProps) {
  return (
    <Box
      alignSelf="flex-start"
      borderStyle="round"
      borderColor={theme.colors.secondary}
      paddingX={1}
    >
      <Text color={theme.colors.secondary}>{glyphs.info} </Text>
      <Text color={theme.colors.text}>{children}</Text>
    </Box>
  );
}
