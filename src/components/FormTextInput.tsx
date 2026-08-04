import { Box, Text } from "ink";
import { TextInput } from "./ui/text-input";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface FormTextInputProps {
  name: string;
  placeholder: string;
  helpText: string;
  errorText: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  pattern?: RegExp;
  // focused controls whether the input captures keystrokes; when several
  // FormTextInputs are on screen, exactly one should be focused.
  focused?: boolean;
}

export function FormTextInput({
  name,
  placeholder,
  helpText,
  errorText,
  value,
  onChange,
  onSubmit,
  pattern,
  focused = true,
}: FormTextInputProps) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text color={theme.colors.text}>{name}</Text>
        <Text color={theme.colors.muted}>{helpText}</Text>
      </Box>
      <Box borderStyle="round" borderColor={focused ? theme.colors.focus : theme.colors.border}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          focus={focused}
        />
      </Box>
      {value !== "" && pattern && !pattern.test(value) && (
        <Text color={theme.colors.error}>{errorText}</Text>
      )}
    </Box>
  );
}
