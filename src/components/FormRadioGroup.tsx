import { Box, Text } from "ink";
import { darkTheme, glyphs } from "./ui/_core.js";

const theme = darkTheme;

export interface FormRadioOption {
  label: string;
  description: string;
}

export interface FormRadioGroupProps {
  name?: string;
  helpText: string;
  options: FormRadioOption[];
  // Row currently owned by the keyboard. Omit while a revealed input has focus.
  focusedIndex?: number;
  // Current radio value. It remains marked while focus moves into a revealed input.
  selectedIndex: number;
}

// FormRadioGroup renders a column of radio rows. It is fully controlled: the
// parent owns the focused index and the key handling that moves it.
export function FormRadioGroup({
  name = "",
  helpText,
  options,
  focusedIndex,
  selectedIndex,
}: FormRadioGroupProps) {
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
          const focused = i === focusedIndex;
          const selected = i === selectedIndex;
          // Focus and selection are separate states: the pointer follows the
          // keyboard, while the radio marker preserves the chosen value.
          const accentColor = focused
            ? theme.colors.focus
            : selected
              ? theme.colors.selection
              : undefined;
          const highlighted = focused || selected;
          return (
            <Box key={option.label} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={focused ? theme.colors.focus : theme.colors.muted}>
                  {focused ? `${glyphs.pointer} ` : "  "}
                </Text>
              </Box>
              <Box width={2} flexShrink={0}>
                <Text color={selected ? theme.colors.selection : theme.colors.muted}>
                  {selected ? "●" : "○"}
                </Text>
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
