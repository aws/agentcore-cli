import React from "react";
import { Box, Text } from "ink";
import { useWindowSize } from "../useWindowSize";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";
import { tokenizeLine } from "./highlight.js";
import type { Language } from "./highlight.js";

export interface CodeBlockProps {
  code: string;
  language?: Language;
  showLineNumbers?: boolean;
  startLine?: number;
  highlightLines?: number[];
  maxHeight?: number;
  showBorder?: boolean;
  title?: string;
  wrap?: boolean;
  theme?: InkUITheme;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language = "plain",
  showLineNumbers = true,
  startLine = 1,
  highlightLines = [],
  maxHeight,
  showBorder = true,
  title,
  wrap = false,
  theme = darkTheme,
}) => {
  const { columns: termWidth } = useWindowSize();

  const lines = code.split("\n");
  const visibleLines = maxHeight ? lines.slice(0, maxHeight) : lines;
  const lineNumWidth = String(startLine + visibleLines.length - 1).length;

  // Map color keys to actual colors
  const colorMap: Record<string, string> = {
    primary: theme.colors.primary,
    success: theme.colors.success,
    warning: theme.colors.warning,
    error: theme.colors.error,
    info: theme.colors.info,
    muted: theme.colors.muted,
    text: theme.colors.text,
    border: theme.colors.border,
  };

  const resolveColor = (c?: string) => (c ? (colorMap[c] ?? c) : undefined);

  const renderLine = (line: string, lineNum: number, index: number) => {
    const isHighlighted = highlightLines.includes(lineNum);
    const truncated =
      !wrap && line.length > termWidth - lineNumWidth - 4
        ? line.slice(0, termWidth - lineNumWidth - 5) + "…"
        : line;

    const tokens = tokenizeLine(truncated, language);

    return (
      <Box
        key={index}
        flexDirection="row"
        backgroundColor={isHighlighted ? theme.colors.selection : undefined}
      >
        {showLineNumbers && (
          <>
            <Text color={theme.colors.muted}>{String(lineNum).padStart(lineNumWidth, " ")}</Text>
            <Text color={theme.colors.border}>{" │ "}</Text>
          </>
        )}
        <Text>
          {tokens.map((tok, ti) => (
            <Text key={ti} color={resolveColor(tok.color)}>
              {tok.text}
            </Text>
          ))}
        </Text>
      </Box>
    );
  };

  const content = (
    <Box flexDirection="column">
      {visibleLines.map((line, i) => renderLine(line, startLine + i, i))}
    </Box>
  );

  if (!showBorder) {
    return (
      <Box flexDirection="column">
        {title && (
          <Text bold color={theme.colors.primary}>
            {title}
          </Text>
        )}
        {content}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border}>
      {title && (
        <Box paddingX={1}>
          <Text bold color={theme.colors.primary}>
            {title}
          </Text>
        </Box>
      )}
      {content}
    </Box>
  );
};
