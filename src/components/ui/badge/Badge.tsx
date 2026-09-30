import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { darkTheme, type InkUITheme } from "../_core";

export interface BadgeProps {
  children: ReactNode;
  theme?: InkUITheme;
  color?: string;
}

const borderStyle = {
  topLeft: "╭",
  top: "─",
  topRight: "┐",
  right: "│",
  bottomRight: "╯",
  bottom: "─",
  bottomLeft: "└",
  left: "│",
} as const;

export function Badge({ children, theme = darkTheme, color = theme.colors.text }: BadgeProps) {
  const label = typeof children === "string" ? children.toUpperCase() : children;

  return (
    <Box borderStyle={borderStyle} borderColor={color} paddingX={1}>
      <Text color={color}>{label}</Text>
    </Box>
  );
}
