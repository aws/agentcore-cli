import { useTextInput } from '../hooks';
import { Cursor } from './Cursor';
import { Box, Text, useStdout } from 'ink';
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
  const { stdout } = useStdout();

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

  // Calculate available width for text display
  // Account for: arrow (2 chars), cursor (1 char), checkmark/x (2 chars), padding (2 chars)
  const terminalWidth = stdout?.columns ?? 80;
  const reservedChars = (hideArrow ? 0 : 2) + 1 + 2 + 2;
  const maxDisplayWidth = Math.max(20, terminalWidth - reservedChars);

  // Get display value (masked or plain)
  const displayValue = mask ? mask.repeat(value.length) : value;

  // Calculate windowed view if text is too long
  let beforeCursor: string;
  let charAtCursor: string;
  let afterCursor: string;
  let showEllipsisBefore = false;
  let showEllipsisAfter = false;

  if (displayValue.length <= maxDisplayWidth) {
    // Text fits - show everything
    beforeCursor = displayValue.slice(0, cursor);
    charAtCursor = displayValue[cursor] ?? ' ';
    afterCursor = displayValue.slice(cursor + 1);
  } else {
    // Text too long - create a window around cursor
    const windowSize = maxDisplayWidth - 2; // Reserve space for ellipsis indicators
    const halfWindow = Math.floor(windowSize / 2);

    let windowStart = Math.max(0, cursor - halfWindow);
    let windowEnd = Math.min(displayValue.length, windowStart + windowSize);

    // Adjust window if we're near the end
    if (windowEnd === displayValue.length) {
      windowStart = Math.max(0, displayValue.length - windowSize);
    }

    // Adjust if we're near the start
    if (windowStart === 0) {
      windowEnd = Math.min(displayValue.length, windowSize);
    }

    showEllipsisBefore = windowStart > 0;
    showEllipsisAfter = windowEnd < displayValue.length;

    const cursorInWindow = cursor - windowStart;
    const windowedText = displayValue.slice(windowStart, windowEnd);
    beforeCursor = windowedText.slice(0, cursorInWindow);
    charAtCursor = windowedText[cursorInWindow] ?? ' ';
    afterCursor = windowedText.slice(cursorInWindow + 1);
  }

  return (
    <Box flexDirection="column">
      {prompt && <Text>{prompt}</Text>}
      <Text wrap="truncate-end">
        {!hideArrow && <Text color="cyan">&gt; </Text>}
        {showEllipsisBefore && <Text dimColor>…</Text>}
        <Text>{beforeCursor}</Text>
        <Cursor char={charAtCursor} />
        <Text>{afterCursor}</Text>
        {showEllipsisAfter && <Text dimColor>…</Text>}
        {!value && placeholder && <Text dimColor>{placeholder.slice(1)}</Text>}
        {showCheckmark && <Text color="green"> ✓</Text>}
        {showInvalidMark && <Text color="red"> ✗</Text>}
      </Text>
      {(showError || showInvalidMark) && validationErrorMsg && <Text color="red">{validationErrorMsg}</Text>}
    </Box>
  );
}
