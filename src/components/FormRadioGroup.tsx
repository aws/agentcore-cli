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
          const selected = i === selectedIndex;
          return (
            <Box key={option.label} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={selected ? theme.colors.focus : theme.colors.muted}>
                  {selected ? "●" : "○"}
                </Text>
              </Box>
              <Box width={columnWidth} flexShrink={0}>
                <Text bold={selected} color={selected ? theme.colors.focus : theme.colors.text}>
                  {option.label}
                </Text>
              </Box>
              <Box flexShrink={1}>
                <Text color={theme.colors.muted}>{option.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
