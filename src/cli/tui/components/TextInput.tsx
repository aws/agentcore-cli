import { useTextInput } from '../hooks';
import { Cursor } from './Cursor';
import { Box, Text } from 'ink';
import { useState } from 'react';
import type { ZodString } from 'zod';

/** Custom validation beyond schema - returns true if valid, or error message string if invalid */
type CustomValidation = (value: string) => true | string;

interface TextInputProps {
  prompt: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
  initialValue?: string;
  /** Zod string schema for validation - error message is extracted from schema */
  schema?: ZodString;
  /** Custom validation beyond schema - both validate function and error message are required together */
  customValidation?: CustomValidation;
  allowEmpty?: boolean;
  /** Mask character to hide input (e.g., '*' for passwords/API keys) */
  mask?: string;
  /** Hide the built-in "> " prompt arrow (default false) */
  hideArrow?: boolean;
  /** Called when up arrow is pressed */
  onUpArrow?: () => void;
  /** Called when down arrow is pressed */
  onDownArrow?: () => void;
}

function validateValue(value: string, schema?: ZodString, customValidation?: CustomValidation): string | undefined {
  if (!value) return undefined;

  if (customValidation) {
    const result = customValidation(value);
    if (result !== true) {
      return result;
    }
  }

  if (schema) {
    const parseResult = schema.safeParse(value);
    if (!parseResult.success) {
      return parseResult.error.issues[0]?.message;
    }
  }

  return undefined;
}

export function TextInput({
  prompt,
  onSubmit,
  onCancel,
  placeholder,
  initialValue = '',
  schema,
  customValidation,
  allowEmpty = false,
  mask,
  hideArrow = false,
  onUpArrow,
  onDownArrow,
}: TextInputProps) {
  const [showError, setShowError] = useState(false);

  const { value, cursor } = useTextInput({
    initialValue,
    onUpArrow,
    onDownArrow,
    onSubmit: val => {
      const trimmed = val.trim();
      const hasValue = allowEmpty || trimmed;
      const validationError = validateValue(trimmed, schema, customValidation);
      if (hasValue && !validationError) {
        onSubmit(trimmed);
      } else {
        setShowError(true);
      }
    },
    onCancel,
  });

  const trimmed = value.trim();
  const validationErrorMsg = validateValue(trimmed, schema, customValidation);
  const isValid = !validationErrorMsg;

  const hasInput = trimmed.length > 0;
  const hasValidation = Boolean(schema ?? customValidation);
  const showCheckmark = hasInput && isValid && hasValidation;
  const showInvalidMark = hasInput && !isValid && hasValidation;

  // Display with cursor position
  const beforeCursor = mask ? mask.repeat(cursor) : value.slice(0, cursor);
  const afterCursor = mask ? mask.repeat(value.length - cursor) : value.slice(cursor);

  return (
    <Box flexDirection="column">
      {prompt && <Text>{prompt}</Text>}
      <Box>
        {!hideArrow && <Text color="cyan">&gt; </Text>}
        <Text>{beforeCursor}</Text>
        <Cursor />
        <Text>{afterCursor}</Text>
        {!value && placeholder && <Text dimColor>{placeholder}</Text>}
        {showCheckmark && <Text color="green"> ✓</Text>}
        {showInvalidMark && <Text color="red"> ✗</Text>}
      </Box>
      {(showError || showInvalidMark) && validationErrorMsg && <Text color="red">{validationErrorMsg}</Text>}
    </Box>
  );
}
