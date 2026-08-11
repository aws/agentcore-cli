import { useState } from "react";
import cliTruncate from "cli-truncate";
import { Box, Text, useInput, useWindowSize } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;
const PREVIEW_LINES = 4;

export interface MultilineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  submitDisabled?: boolean;
}

function Cursor({ character }: { character: string }) {
  return (
    <Text color={theme.colors.focus} inverse>
      {character}
    </Text>
  );
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  placeholder = "Enter text",
  submitDisabled = false,
}: MultilineInputProps) {
  const { columns } = useWindowSize();
  const [rawCursor, setRawCursor] = useState(value.length);
  const cursor = Math.min(rawCursor, value.length);

  useInput((input, key) => {
    if (key.leftArrow) {
      setRawCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setRawCursor(Math.min(value.length, cursor + 1));
      return;
    }
    if (key.upArrow || key.downArrow) return;

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      onChange(value.slice(0, cursor - 1) + value.slice(cursor));
      setRawCursor(cursor - 1);
      return;
    }

    if (key.return) {
      if (key.shift || key.meta) {
        onChange(value.slice(0, cursor) + "\n" + value.slice(cursor));
        setRawCursor(cursor + 1);
      } else if (!submitDisabled) {
        onSubmit();
      }
      return;
    }
    if (key.ctrl || key.meta || key.escape || input === "") return;

    const next = input.replace(/\r/g, "\n");
    onChange(value.slice(0, cursor) + next + value.slice(cursor));
    setRawCursor(cursor + next.length);
  });

  if (value === "") {
    return (
      <Box>
        <Cursor character={placeholder[0] ?? " "} />
        <Text color={theme.colors.muted}>{placeholder.slice(1)}</Text>
      </Box>
    );
  }

  const lines = value.split("\n");
  const beforeCursor = value.slice(0, cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const lastNewline = beforeCursor.lastIndexOf("\n");
  const cursorColumn = cursor - lastNewline - 1;
  const start = Math.max(0, cursorLine - PREVIEW_LINES + 1);
  const visible = lines.slice(start, start + PREVIEW_LINES);

  return (
    <Box flexDirection="column">
      {visible.map((line, index) => {
        const lineIndex = start + index;
        const prefix = index === 0 && start > 0 ? "… " : "";
        if (lineIndex !== cursorLine) {
          return (
            <Box key={lineIndex} width={columns}>
              <Text wrap="truncate-end">{cliTruncate(`${prefix}${line || " "}`, columns)}</Text>
            </Box>
          );
        }

        const horizontalMarker = cursorColumn >= columns - prefix.length ? "… " : "";
        const available = Math.max(1, columns - prefix.length - horizontalMarker.length);
        const offset = Math.max(0, cursorColumn - available + 1);
        const before = line.slice(offset, cursorColumn);
        const at = line[cursorColumn] ?? " ";
        const after = line.slice(
          cursorColumn + 1,
          cursorColumn + 1 + Math.max(0, available - before.length - 1),
        );
        return (
          <Box key={lineIndex} width={columns}>
            <Text color={theme.colors.border}>{prefix}</Text>
            <Text color={theme.colors.border}>{horizontalMarker}</Text>
            {before ? <Text>{before}</Text> : null}
            <Cursor character={at} />
            {after ? <Text>{after}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
