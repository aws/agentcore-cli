import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface FormTextAreaProps {
  name: string;
  helpText: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  // previewLines caps how many trailing lines are shown; earlier lines fold
  // into a "… (+N earlier lines)" marker.
  previewLines?: number;
  // focused controls whether the textarea captures keystrokes.
  focused?: boolean;
}

function Cursor({ character, focused }: { character: string; focused: boolean }) {
  return focused ? <Text inverse>{character}</Text> : <Text>{character}</Text>;
}

export function FormTextArea({
  name,
  helpText,
  placeholder,
  value,
  onChange,
  previewLines = 10,
  focused = true,
}: FormTextAreaProps) {
  const [rawCursor, setRawCursor] = useState(value.length);
  const cursor = Math.min(rawCursor, value.length);

  useInput(
    (input, key) => {
      if (key.leftArrow) {
        setRawCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setRawCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.upArrow || key.downArrow) return;

      if (key.return) {
        if (value !== "") {
          onChange(value.slice(0, cursor) + "\n" + value.slice(cursor));
          setRawCursor(cursor + 1);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setRawCursor(cursor - 1);
        return;
      }
      if (key.ctrl || key.meta || key.escape) return;
      if (input !== "") {
        const next = input.replace(/\r/g, "\n");
        onChange(value.slice(0, cursor) + next + value.slice(cursor));
        setRawCursor(cursor + next.length);
      }
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderTop={false}
        borderColor={theme.colors.border}
      >
        <Text color={theme.colors.text}>{name}</Text>
        <Text color={theme.colors.muted}>{helpText}</Text>
      </Box>
      {value === "" ? (
        <Text color={theme.colors.muted}>
          <Cursor character={placeholder[0] ?? " "} focused={focused} />
          {placeholder.slice(1)}
        </Text>
      ) : (
        <TextAreaValue
          value={value}
          cursor={cursor}
          previewLines={previewLines}
          focused={focused}
        />
      )}
    </Box>
  );
}

function TextAreaValue({
  value,
  cursor,
  previewLines,
  focused,
}: {
  value: string;
  cursor: number;
  previewLines: number;
  focused: boolean;
}) {
  const lines = value.split("\n");
  const beforeCursor = value.slice(0, cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const lastNewline = beforeCursor.lastIndexOf("\n");
  const cursorColumn = cursor - lastNewline - 1;
  const start = Math.max(0, cursorLine - previewLines + 1);
  const visible = lines.slice(start, start + previewLines);

  return (
    <>
      {start > 0 ? <Text color={theme.colors.muted}>… (+{start} earlier lines)</Text> : null}
      {visible.map((line, index) => {
        const lineIndex = start + index;
        if (lineIndex !== cursorLine) return <Text key={lineIndex}>{line}</Text>;

        return (
          <Text key={lineIndex}>
            {line.slice(0, cursorColumn)}
            <Cursor character={line[cursorColumn] ?? " "} focused={focused} />
            {line.slice(cursorColumn + 1)}
          </Text>
        );
      })}
    </>
  );
}
