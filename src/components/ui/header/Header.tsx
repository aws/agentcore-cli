import React from "react";
import { Text, Box, useStdout } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export type HeaderStyle = "box" | "line" | "filled";

export interface HeaderProps {
  title: string;
  version?: string;
  subtitle?: string;
  style?: HeaderStyle;
  align?: "left" | "center";
  theme?: InkUITheme;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  version,
  subtitle,
  style = "box",
  // eslint-disable-next-line no-unused-vars
  align = "left",
  theme = darkTheme,
}) => {
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;
  const fullTitle = version ? `${title} v${version}` : title;

  if (style === "box") {
    // ┌─── MyApp v1.0 ──────────────────┐
    const inner = w - 2; // exclude ┌ and ┐
    const label = ` ${fullTitle} `;
    const left = 3; // ─── before label
    const right = Math.max(0, inner - left - label.length);
    const top = "┌" + "─".repeat(left) + label + "─".repeat(right) + "┐";
    const bot = "└" + "─".repeat(inner) + "┘";

    return (
      <Box flexDirection="column">
        <Text color={theme.colors.primary}>{top}</Text>
        {subtitle && (
          <Text color={theme.colors.primary}>
            {"│"} <Text color={theme.colors.muted}>{subtitle.padEnd(inner - 2)}</Text> {"│"}
          </Text>
        )}
        <Text color={theme.colors.primary}>{bot}</Text>
      </Box>
    );
  }

  if (style === "line") {
    // ══ MyApp v1.0 ════════════════════
    const label = ` ${fullTitle} `;
    const pre = "══";
    const remaining = Math.max(0, w - pre.length - label.length);
    const line = pre + label + "═".repeat(remaining);

    return (
      <Box flexDirection="column">
        <Text color={theme.colors.primary}>{line}</Text>
        {subtitle && <Text color={theme.colors.muted}> {subtitle}</Text>}
      </Box>
    );
  }

  // filled: ███ MyApp v1.0 ████████████
  const label = ` ${fullTitle} `;
  const pre = "██ ";
  const remaining = Math.max(0, w - pre.length - label.length);
  const line = pre + label + "█".repeat(remaining);

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.primary}>{line}</Text>
      {subtitle && <Text color={theme.colors.muted}> {subtitle}</Text>}
    </Box>
  );
};
