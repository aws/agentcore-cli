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

function Cursor({ character }: { character: string }) {
  return (
    <Text color={theme.colors.focus} inverse>
      {character}
    </Text>
  );
}

// FormTextArea is a minimal multiline editor with cursor-aware typing,
// pasting and backspace. Pasted chunks arrive as one input string whose \r
// become newlines, so multi-line paste just works. Enter inserts a newline
// only once there is content — on an empty value it is left to the parent
// (e.g. to continue a wizard step).
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

  const lines = value === "" ? [] : value.split("\n");
  const beforeCursor = value.slice(0, cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const lastNewline = beforeCursor.lastIndexOf("\n");
  const cursorColumn = cursor - lastNewline - 1;
  const hidden = Math.max(0, cursorLine - previewLines + 1);
  const visible = lines.slice(hidden, hidden + previewLines);
  const hiddenAfter = Math.max(0, lines.length - hidden - visible.length);

  return (
    <Box flexDirection="column">
      {/* Either row is omitted when empty, so a caller whose surrounding
          context already asks the question renders just the editor. */}
      {(name !== "" || helpText !== "") && (
        <Box flexDirection="column">
          {name !== "" && <Text color={theme.colors.text}>{name}</Text>}
          {helpText !== "" && <Text color={theme.colors.muted}>{helpText}</Text>}
        </Box>
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focused ? theme.colors.focus : theme.colors.border}
      >
        {hidden > 0 && <Text color={theme.colors.muted}>… (+{hidden} earlier lines)</Text>}
        {visible.length === 0 ? (
          <Text color={theme.colors.muted}>
            {placeholder}
            <Cursor character=" " />
          </Text>
        ) : (
          visible.map((line, i) => {
            const lineIndex = hidden + i;
            if (lineIndex !== cursorLine) return <Text key={lineIndex}>{line || " "}</Text>;

            const before = line.slice(0, cursorColumn);
            const at = line[cursorColumn] ?? " ";
            const after = line.slice(cursorColumn + 1);
            return (
              <Text key={lineIndex}>
                {before}
                <Cursor character={at} />
                {after}
              </Text>
            );
          })
        )}
        {hiddenAfter > 0 && <Text color={theme.colors.muted}>… (+{hiddenAfter} later lines)</Text>}
      </Box>
    </Box>
  );
}
