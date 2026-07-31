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

// FormTextArea is a minimal multiline editor: append-only typing/pasting plus
// backspace. Pasted chunks arrive as one input string whose \r become
// newlines, so multi-line paste just works. Enter inserts a newline only once
// there is content — on an empty value it is left to the parent (e.g. to
// continue a wizard step).
export function FormTextArea({
  name,
  helpText,
  placeholder,
  value,
  onChange,
  previewLines = 10,
  focused = true,
}: FormTextAreaProps) {
  useInput(
    (input, key) => {
      if (key.return) {
        if (value !== "") onChange(value + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.escape) return;
      if (input !== "") {
        onChange(value + input.replace(/\r/g, "\n"));
      }
    },
    { isActive: focused },
  );

  const lines = value === "" ? [] : value.split("\n");
  const hidden = Math.max(0, lines.length - previewLines);
  const visible = lines.slice(hidden);

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
      {hidden > 0 && <Text color={theme.colors.muted}>… (+{hidden} earlier lines)</Text>}
      {visible.length === 0 ? (
        <Text color={theme.colors.muted}>
          {placeholder}
          <Text inverse> </Text>
        </Text>
      ) : (
        visible.map((line, i) => (
          <Text key={i}>
            {line}
            {i === visible.length - 1 ? <Text inverse> </Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}
