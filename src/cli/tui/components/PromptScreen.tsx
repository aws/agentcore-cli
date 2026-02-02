import { Panel } from './Panel';
import { ScreenLayout } from './ScreenLayout';
import { TextInput } from './TextInput';
import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';

interface PromptScreenProps {
  /** Main message or content */
  children: ReactNode;
  /** Help text showing available actions */
  helpText: string;
  /** Called when primary action is triggered (Enter or 'y') */
  onConfirm?: () => void;
  /** Called when secondary/back action is triggered (Enter or 'b') */
  onBack?: () => void;
  /** Called when exit is triggered (Escape or Ctrl+Q or 'n') */
  onExit?: () => void;
  /** Panel border color (default: undefined, no color) */
  borderColor?: string;
  /** Disable built-in key handling when another input is active */
  inputEnabled?: boolean;
}

/**
 * Simple prompt screen for confirmations, errors, and other modal-like prompts.
 * Handles common Y/N/Enter/Escape patterns.
 *
 * @example
 * ```tsx
 * <PromptScreen
 *   helpText="Press Enter to confirm, Esc to cancel"
 *   onConfirm={handleConfirm}
 *   onExit={handleCancel}
 * >
 *   <Text>Are you sure you want to proceed?</Text>
 * </PromptScreen>
 * ```
 */
export function PromptScreen({
  children,
  helpText,
  onConfirm,
  onBack,
  onExit,
  borderColor,
  inputEnabled = true,
}: PromptScreenProps) {
  useInput((input, key) => {
    if (!inputEnabled) {
      return;
    }
    if (key.escape || (key.ctrl && input === 'q') || input === 'n') {
      onExit?.();
      return;
    }
    if (key.return || input === 'y') {
      onConfirm?.();
      return;
    }
    if (input === 'b') {
      onBack?.();
    }
  });

  return (
    <ScreenLayout>
      <Panel borderColor={borderColor}>
        <Box flexDirection="column" gap={1}>
          {children}
          <Text dimColor>{helpText}</Text>
        </Box>
      </Panel>
    </ScreenLayout>
  );
}

/**
 * Success prompt - shows a success message with confirm/exit actions.
 */
export function SuccessPrompt({
  message,
  detail,
  onConfirm,
  onExit,
  confirmText = 'Continue',
  exitText = 'Exit',
}: {
  message: string;
  detail?: string;
  onConfirm?: () => void;
  onExit?: () => void;
  confirmText?: string;
  exitText?: string;
}) {
  const helpText = onConfirm
    ? `Enter/Y to ${confirmText.toLowerCase()}, Esc/N to ${exitText.toLowerCase()}`
    : `Press any key to ${exitText.toLowerCase()}`;

  return (
    <PromptScreen helpText={helpText} onConfirm={onConfirm} onExit={onExit} borderColor="green">
      <Text color="green">{message}</Text>
      {detail && <Text>{detail}</Text>}
    </PromptScreen>
  );
}

/**
 * Error prompt - shows an error message with back/exit actions.
 * Uses plain text styling (no box) to match success screen pattern.
 */
export function ErrorPrompt({
  message,
  detail,
  onBack,
  onExit,
}: {
  message: string;
  detail?: string;
  onBack?: () => void;
  onExit?: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'q') || input === 'n') {
      onExit?.();
      return;
    }
    if (key.return || input === 'y' || input === 'b') {
      onBack?.();
    }
  });

  return (
    <ScreenLayout>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color="red">✗ {message}</Text>
          {detail && <Text>{detail}</Text>}
        </Box>
        <Text dimColor>Enter/B to go back, Esc/Q to exit</Text>
      </Box>
    </ScreenLayout>
  );
}

/**
 * Confirm prompt - asks a yes/no question.
 */
export function ConfirmPrompt({
  message,
  detail,
  onConfirm,
  onCancel,
  showInput = false,
  inputPrompt = 'Confirm (y/n)',
}: {
  message: string;
  detail?: string;
  onConfirm: () => void;
  onCancel: () => void;
  showInput?: boolean;
  inputPrompt?: string;
}) {
  const helpText = showInput ? 'Type y/n · Enter submit · Esc cancel' : 'Enter/Y confirm · Esc/N cancel';

  return (
    <PromptScreen
      helpText={helpText}
      onConfirm={showInput ? undefined : onConfirm}
      onExit={onCancel}
      inputEnabled={!showInput}
    >
      <Text>{message}</Text>
      {detail && <Text dimColor>{detail}</Text>}
      {showInput && (
        <TextInput
          prompt={inputPrompt}
          placeholder="y/n"
          customValidation={value => {
            const normalized = value.trim().toLowerCase();
            if (!normalized) return 'Enter y or n';
            if (normalized === 'y' || normalized === 'yes' || normalized === 'n' || normalized === 'no') {
              return true;
            }
            return 'Enter y or n';
          }}
          onSubmit={value => {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'y' || normalized === 'yes') {
              onConfirm();
              return;
            }
            if (normalized === 'n' || normalized === 'no') {
              onCancel();
            }
          }}
          onCancel={onCancel}
        />
      )}
    </PromptScreen>
  );
}
