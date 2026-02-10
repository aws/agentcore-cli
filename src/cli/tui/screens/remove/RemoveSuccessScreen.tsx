import { LogLink, type NextStep, NextSteps, Screen } from '../../components';
import { Box, Text } from 'ink';
import React from 'react';

const REMOVE_SUCCESS_STEPS: NextStep[] = [{ command: 'remove', label: 'Remove another resource' }];

interface RemoveSuccessScreenProps {
  /** Whether running in interactive TUI mode */
  isInteractive: boolean;
  /** Success message (shown in green) */
  message: string;
  /** Optional detail text */
  detail?: string;
  /** Path to the log file showing the schema diff */
  logFilePath?: string | null;
  /** Called when "Remove another resource" is selected */
  onRemoveAnother: () => void;
  /** Called when "return" is selected to go back to main menu, or in non-interactive exit */
  onExit: () => void;
}

export function RemoveSuccessScreen({
  isInteractive,
  message,
  detail,
  logFilePath,
  onRemoveAnother,
  onExit,
}: RemoveSuccessScreenProps) {
  const handleSelect = (step: NextStep) => {
    if (step.command === 'remove') {
      onRemoveAnother();
    }
  };

  // Non-interactive mode - just show success message
  if (!isInteractive) {
    return (
      <Screen title="Success" onExit={onExit}>
        <Box flexDirection="column">
          <Text color="green">✓ {message}</Text>
          {detail && <Text>{detail}</Text>}
          <Text dimColor>Your source code has not been modified.</Text>
          {logFilePath && <LogLink filePath={logFilePath} label="Diff" />}
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title="Success" onExit={onExit}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color="green">✓ {message}</Text>
          {detail && <Text>{detail}</Text>}
          <Text dimColor>Your source code has not been modified.</Text>
          {logFilePath && <LogLink filePath={logFilePath} label="Diff" />}
        </Box>
        <NextSteps steps={REMOVE_SUCCESS_STEPS} isInteractive={true} onSelect={handleSelect} onBack={onExit} />
      </Box>
    </Screen>
  );
}
