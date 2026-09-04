import { Box, Text } from "ink";
import { darkTheme, glyphs } from "./ui/_core.js";

const theme = darkTheme;

export interface FormCheckboxOption {
  label: string;
  description: string;
  checked: boolean;
}

export interface FormCheckboxMultiSelectProps {
  name: string;
  helpText: string;
  options: FormCheckboxOption[];
  // cursorIndex highlights the row the cursor is on; pass -1 for none (e.g.
  // while a related input has focus).
  cursorIndex: number;
}

// FormCheckboxMultiSelect renders a column of checkbox rows. It is fully
// controlled: the parent owns the checked states, the cursor, and the key
// handling that moves and toggles them.
export function FormCheckboxMultiSelect({
  name,
  helpText,
  options,
  cursorIndex,
}: FormCheckboxMultiSelectProps) {
  const columnWidth = options.reduce((max, option) => Math.max(max, option.label.length), 0) + 2;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text color={theme.colors.text}>{name}</Text>
        <Text color={theme.colors.muted}>{helpText}</Text>
      </Box>
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor={theme.colors.border}
      >
        {options.map((option, i) => {
          const isCursor = i === cursorIndex;
          return (
            <Box key={option.label}>
              <Text color={isCursor ? theme.colors.focus : theme.colors.muted}>
                {isCursor ? `${glyphs.pointer} ` : "  "}
              </Text>
              <Text color={option.checked ? theme.colors.success : theme.colors.muted}>
                {option.checked ? `[${glyphs.done}] ` : "[ ] "}
              </Text>
              <Text bold={isCursor} color={isCursor ? theme.colors.focus : theme.colors.text}>
                {option.label.padEnd(columnWidth)}
              </Text>
              <Text color={option.checked ? theme.colors.text : theme.colors.muted}>
                {option.description}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
