import { Box, Text } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface FormRadioOption {
  label: string;
  description: string;
}

export interface FormRadioGroupProps {
  name: string;
  helpText: string;
  options: FormRadioOption[];
  selectedIndex: number;
}

// FormRadioGroup renders a column of radio rows. It is fully controlled: the
// parent owns the selected index and the key handling that moves it.
export function FormRadioGroup({ name, helpText, options, selectedIndex }: FormRadioGroupProps) {
  const columnWidth = options.reduce((max, option) => Math.max(max, option.label.length), 0) + 2;

  return (
    <Box flexDirection="column">
      {/* Either row is omitted when empty, so a caller whose surrounding
          context already asks the question renders just the options. */}
      {(name !== "" || helpText !== "") && (
        <Box flexDirection="column">
          {name !== "" && <Text color={theme.colors.text}>{name}</Text>}
          {helpText !== "" && <Text color={theme.colors.muted}>{helpText}</Text>}
        </Box>
      )}
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor={theme.colors.border}
      >
        {options.map((option, i) => {
          const selected = i === selectedIndex;
          return (
            <Box key={option.label}>
              <Text color={selected ? theme.colors.focus : theme.colors.muted}>
                {selected ? "● " : "○ "}
              </Text>
              <Text bold={selected} color={selected ? theme.colors.focus : theme.colors.text}>
                {option.label.padEnd(columnWidth)}
              </Text>
              <Text color={theme.colors.muted}>{option.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
