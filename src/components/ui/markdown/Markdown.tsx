import React from "react";
import { Box, Text } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface MarkdownProps {
  content: string;
  width?: number;
  highlightCode?: boolean;
  maxHeight?: number;
  theme?: InkUITheme;
}

interface InlineToken {
  type: "text" | "bold" | "italic" | "code" | "link" | "strikethrough";
  text: string;
  url?: string;
}

function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < line.length) {
    // Bold
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end !== -1) {
        tokens.push({ type: "bold", text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Strikethrough
    if (line.startsWith("~~", i)) {
      const end = line.indexOf("~~", i + 2);
      if (end !== -1) {
        tokens.push({ type: "strikethrough", text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Italic
    if (line[i] === "*" && line[i + 1] !== "*") {
      const end = line.indexOf("*", i + 1);
      if (end !== -1) {
        tokens.push({ type: "italic", text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Inline code
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        tokens.push({ type: "code", text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Link [text](url)
    if (line[i] === "[") {
      const textEnd = line.indexOf("]", i);
      if (textEnd !== -1 && line[textEnd + 1] === "(") {
        const urlEnd = line.indexOf(")", textEnd + 2);
        if (urlEnd !== -1) {
          tokens.push({
            type: "link",
            text: line.slice(i + 1, textEnd),
            url: line.slice(textEnd + 2, urlEnd),
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // Regular text: accumulate
    const start = i;
    while (
      i < line.length &&
      line[i] !== "*" &&
      line[i] !== "`" &&
      line[i] !== "[" &&
      !line.startsWith("~~", i)
    ) {
      i++;
    }
    if (i > start) tokens.push({ type: "text", text: line.slice(start, i) });
    else i++; // safety
  }

  return tokens;
}

function renderInline(tokens: InlineToken[], theme: InkUITheme): React.ReactElement {
  return (
    <>
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case "bold":
            return (
              <Text key={i} bold>
                {tok.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic>
                {tok.text}
              </Text>
            );
          case "strikethrough":
            return (
              <Text key={i} strikethrough>
                {tok.text}
              </Text>
            );
          case "code":
            return (
              <Text key={i} color={theme.colors.info} inverse>
                {tok.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i}>
                <Text key={`${i}t`} underline color={theme.colors.primary}>
                  {tok.text}
                </Text>
                <Text key={`${i}u`} color={theme.colors.muted} dimColor>{` (${tok.url})`}</Text>
              </Text>
            );
          default:
            return <Text key={i}>{tok.text}</Text>;
        }
      })}
    </>
  );
}

export const Markdown: React.FC<MarkdownProps> = ({ content, theme = darkTheme }) => {
  const lines = content.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    // Note: assertion is safe based on bound above.
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      // Note: assertions on lines[i] are safe based on first term in the while condition.
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      elements.push(
        <Box
          key={i}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.colors.border}
          paddingX={1}
          marginY={0}
        >
          {lang && (
            <Text color={theme.colors.muted} dimColor>
              {lang}
            </Text>
          )}
          {codeLines.map((cl, ci) => (
            <Text key={ci} color={theme.colors.text}>
              {cl}
            </Text>
          ))}
        </Box>,
      );
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      elements.push(
        <Text key={i} color={theme.colors.border}>
          {"─".repeat(40)}
        </Text>,
      );
      i++;
      continue;
    }

    // H1
    if (line.startsWith("# ")) {
      elements.push(
        <Text key={i} bold color={theme.colors.primary}>
          {line.slice(2)}
        </Text>,
      );
      i++;
      continue;
    }

    // H2
    if (line.startsWith("## ")) {
      elements.push(
        <Text key={i} bold color={theme.colors.secondary}>
          {line.slice(3)}
        </Text>,
      );
      i++;
      continue;
    }

    // H3
    if (line.startsWith("### ")) {
      elements.push(
        <Text key={i} bold>
          {line.slice(4)}
        </Text>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      elements.push(
        <Box key={i} flexDirection="row">
          <Text color={theme.colors.muted}>{"│ "}</Text>
          <Text italic color={theme.colors.muted}>
            {line.slice(2)}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Unordered list
    if (/^[\s-*]\s/.test(line) && (line.startsWith("- ") || line.startsWith("* "))) {
      elements.push(
        <Box key={i} flexDirection="row">
          <Text color={theme.colors.primary}>{"  • "}</Text>
          <Text>{renderInline(parseInline(line.slice(2)), theme)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)\.\s(.*)/);
    if (olMatch) {
      // note: if the regex matched, there must be number at olMatch[1], so assertion is safe.
      elements.push(
        <Box key={i} flexDirection="row">
          <Text color={theme.colors.primary}>{`  ${olMatch[1]!}. `}</Text>
          <Text>{renderInline(parseInline(olMatch[2] ?? ""), theme)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      elements.push(<Text key={i}> </Text>);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(<Text key={i}>{renderInline(parseInline(line), theme)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
};
