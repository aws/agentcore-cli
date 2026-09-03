import { Box, Text } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface FormRadioOption {
  label: string;
  description: string;
}

export interface FormRadioGroupProps {
  name?: string;
  helpText: string;
  options: FormRadioOption[];
  // highlighted/hovered row
  focusedIndex: number;
  // row that user selects / hits ENTER on
  selectedIndex?: number;
}

// FormRadioGroup renders a column of radio rows. It is fully controlled: the
// parent owns the focused index and the key handling that moves it.
export function FormRadioGroup({
  name,
  helpText,
  options,
  focusedIndex,
  selectedIndex,
}: FormRadioGroupProps) {
  const columnWidth = options.reduce((max, option) => Math.max(max, option.label.length), 0) + 2;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {name && <Text color={theme.colors.text}>{name}</Text>}
        <Text color={theme.colors.muted}>{helpText}</Text>
      </Box>
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor={theme.colors.border}
      >
        {options.map((option, i) => {
          const focused = i === focusedIndex;
          const selected = i === selectedIndex;
          // A selected row uses the selection color; a hovered (focused) row
          // uses the brighter focus color; everything else is neutral.
          const accentColor = selected
            ? theme.colors.selection
            : focused
              ? theme.colors.focus
              : undefined;
          const highlighted = focused || selected;
          return (
            <Box key={option.label} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={accentColor ?? theme.colors.muted}>{highlighted ? "●" : "○"}</Text>
              </Box>
              <Box width={columnWidth} flexShrink={0}>
                <Text bold={highlighted} color={accentColor ?? theme.colors.text}>
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
