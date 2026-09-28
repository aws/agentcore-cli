import React from "react";
import { Box, Text, useWindowSize } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface ProgressBarProps {
  /** Progress value 0–100 */
  value: number;
  /** Optional label shown to the left of the bar */
  label?: string;
  /** Show percentage at the right end */
  showPercent?: boolean;
  /** Fixed bar width in columns — defaults to auto (fills terminal width) */
  width?: number;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
}

const FILL = "█";
const EMPTY = "░";

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  label,
  showPercent = true,
  width,
  theme = darkTheme,
}) => {
  const { columns: termWidth } = useWindowSize();

  // Clamp value to [0, 100]
  const pct = Math.min(100, Math.max(0, value));

  // Build the bar width:
  // total - label - space - percent suffix (e.g. " 100%") - 2 padding spaces
  const percentSuffix = showPercent ? ` ${String(Math.round(pct)).padStart(3)}%` : "";
  const labelPrefix = label ? `${label} ` : "";
  const overhead = labelPrefix.length + percentSuffix.length;
  const barWidth = width ?? Math.max(8, termWidth - overhead);

  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  const filledStr = FILL.repeat(filled);
  const emptyStr = EMPTY.repeat(empty);

  return (
    <Box>
      {label ? <Text>{label} </Text> : null}
      <Text color={theme.colors.primary}>{filledStr}</Text>
      <Text color={theme.colors.muted}>{emptyStr}</Text>
      {showPercent ? <Text color={theme.colors.muted}>{percentSuffix}</Text> : null}
    </Box>
  );
};
