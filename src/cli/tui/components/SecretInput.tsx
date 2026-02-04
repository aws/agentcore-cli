import { useTextInput } from '../hooks';
import { Cursor } from './Cursor';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { ZodString } from 'zod';

// Width for each line of input display (account for borders, padding, prompt)
const LINE_WIDTH = 52;

/** Custom validation beyond schema - returns true if valid, or error message string if invalid */
type CustomValidation = (value: string) => true | string;

export interface SecretInputProps {
  /** Label displayed above the input */
  prompt: string;
  /** Called when user submits a value */
  onSubmit: (value: string) => void;
  /** Called when user cancels (Esc) */
  onCancel: () => void;
  /** Called when user skips (empty value + Enter). If not provided, empty values are treated as cancel. */
  onSkip?: () => void;
  /** Initial value */
  initialValue?: string;
  /** Zod string schema for validation */
  schema?: ZodString;
  /** Custom validation function */
  customValidation?: CustomValidation;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Optional description shown below the prompt */
  description?: string;
  /** Whether this component should receive input */
  isActive?: boolean;
  /** Character used for masking (default: '*') */
  maskChar?: string;
  /** Show partial value for verification (first/last N chars). 0 = fully masked. Default: 0 */
  revealChars?: number;
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

/**
 * Secure input component for sensitive data like API keys and passwords.
 *
 * Features:
 * - Masked input by default
 * - Tab to toggle show/hide
 * - Optional partial reveal (show first/last N chars)
 * - Validation support (Zod schema and custom)
 * - Skip functionality for optional inputs
 */
export function SecretInput({
  prompt,
  onSubmit,
  onCancel,
  onSkip,
  initialValue = '',
  schema,
  customValidation,
  placeholder,
  description,
  isActive = true,
  maskChar = '*',
  revealChars = 0,
}: SecretInputProps) {
  const [showValue, setShowValue] = useState(false);
  const [showError, setShowError] = useState(false);

  const { value, cursor } = useTextInput({
    initialValue,
    onSubmit: val => {
      const trimmed = val.trim();
      if (!trimmed) {
        if (onSkip) {
          onSkip();
        } else {
          onCancel();
        }
        return;
      }
      const validationError = validateValue(trimmed, schema, customValidation);
      if (!validationError) {
        onSubmit(trimmed);
      } else {
        setShowError(true);
      }
    },
    onCancel,
    onChange: () => setShowError(false),
    isActive,
  });

  // Handle Tab separately for show/hide toggle
  useInput(
    (_input, key) => {
      if (key.tab) {
        setShowValue(s => !s);
      }
    },
    { isActive }
  );

  const trimmed = value.trim();
  const validationErrorMsg = validateValue(trimmed, schema, customValidation);
  const isValid = !validationErrorMsg;

  // Generate display value (masked or plain)
  const getDisplayValue = (): string => {
    if (showValue) {
      return value;
    }

    if (value.length === 0) {
      return '';
    }

    const cursorAtEnd = cursor === value.length;

    // Editing (cursor not at end) - show actual value so user can see what they're doing
    if (!cursorAtEnd) {
      return value;
    }

    // Done typing (cursor at end) - show partial reveal if configured
    if (revealChars > 0 && value.length > revealChars * 2) {
      const start = value.slice(0, revealChars);
      const end = value.slice(-revealChars);
      const middleLength = value.length - revealChars * 2;
      return `${start}${maskChar.repeat(middleLength)}${end}`;
    }

    // Full mask (no reveal configured or value too short)
    return maskChar.repeat(value.length);
  };

  // Split text into lines and determine which line has the cursor
  const getLines = (): { lines: string[]; cursorLine: number; cursorCol: number } => {
    const displayValue = getDisplayValue();
    if (displayValue.length === 0) {
      return { lines: [], cursorLine: 0, cursorCol: 0 };
    }

    const lines: string[] = [];
    for (let i = 0; i < displayValue.length; i += LINE_WIDTH) {
      lines.push(displayValue.slice(i, i + LINE_WIDTH));
    }

    const cursorLine = Math.floor(cursor / LINE_WIDTH);
    const cursorCol = cursor % LINE_WIDTH;

    return { lines, cursorLine, cursorCol };
  };

  const { lines, cursorLine, cursorCol } = getLines();
  const hasInput = trimmed.length > 0;
  const hasValidation = Boolean(schema ?? customValidation);
  const showCheckmark = hasInput && isValid && hasValidation;
  const showInvalidMark = hasInput && !isValid && hasValidation;

  // Render a line with cursor if this is the cursor line
  // Cursor overlays the character at position (or shows space at end)
  const renderLine = (line: string, lineIndex: number, isFirstLine: boolean) => {
    const isCursorLine = lineIndex === cursorLine;
    const prefix = isFirstLine ? <Text color="cyan">&gt; </Text> : <Text> </Text>;

    if (isCursorLine) {
      const before = line.slice(0, cursorCol);
      const charAtCursor = line[cursorCol] ?? ' '; // Space if at end of line
      const after = line.slice(cursorCol + 1);

      return (
        <Text key={lineIndex}>
          {prefix}
          <Text>{before}</Text>
          <Cursor char={charAtCursor} />
          <Text>{after}</Text>
          {isFirstLine && showCheckmark && <Text color="green"> ✓</Text>}
          {isFirstLine && showInvalidMark && <Text color="red"> ✗</Text>}
        </Text>
      );
    }

    return (
      <Text key={lineIndex}>
        {prefix}
        <Text>{line}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Text bold>{prompt}</Text>
      {description && (
        <Box marginTop={1}>
          <Text dimColor>{description}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {value ? (
          lines.map((line, i) => renderLine(line, i, i === 0))
        ) : placeholder ? (
          <Text>
            <Text color="cyan">&gt; </Text>
            <Cursor char={placeholder[0] ?? ' '} />
            <Text dimColor>{placeholder.slice(1)}</Text>
          </Text>
        ) : (
          <Text>
            <Text color="cyan">&gt; </Text>
            <Cursor />
          </Text>
        )}
      </Box>
      {(showError || showInvalidMark) && validationErrorMsg && (
        <Box marginTop={1}>
          <Text color="red">{validationErrorMsg}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Tab to {showValue ? 'hide' : 'show'} · Enter to submit · Esc to {onSkip ? 'go back' : 'cancel'}
          {onSkip && ' · Leave empty to skip'}
        </Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialized variants for common use cases
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeySecretInputProps {
  /** Model provider name for display */
  providerName: string;
  /** Environment variable name for the API key */
  envVarName: string;
  /** Called when user submits an API key */
  onSubmit: (apiKey: string) => void;
  /** Called when user skips */
  onSkip: () => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Whether this component should receive input */
  isActive?: boolean;
}

/**
 * Specialized SecretInput for API keys with provider-specific messaging.
 */
export function ApiKeySecretInput({
  providerName,
  envVarName,
  onSubmit,
  onSkip,
  onCancel,
  isActive = true,
}: ApiKeySecretInputProps) {
  return (
    <Box flexDirection="column">
      <SecretInput
        prompt={`${providerName} API Key`}
        description={`Enter your ${providerName} API key. This will be stored in .env.local for local development.
For deployment, the key will be securely stored in AgentCore Identity.`}
        placeholder={envVarName}
        onSubmit={onSubmit}
        onSkip={onSkip}
        onCancel={onCancel}
        isActive={isActive}
        revealChars={0}
      />
    </Box>
  );
}
