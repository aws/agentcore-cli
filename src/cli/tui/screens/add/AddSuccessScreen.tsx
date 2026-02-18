import { GradientText, type NextStep, NextSteps, Screen } from '../../components';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import React from 'react';

/** Next steps shown after successfully adding a resource */
// eslint-disable-next-line react-refresh/only-export-components
export function getAddSuccessSteps(showDevOption: boolean): NextStep[] {
  if (showDevOption) {
    return [
      { command: 'dev', label: 'Run agent locally' },
      { command: 'deploy', label: 'Deploy to AWS' },
      { command: 'add', label: 'Add another resource' },
    ];
  }
  return [
    { command: 'deploy', label: 'Deploy to AWS' },
    { command: 'add', label: 'Add another resource' },
  ];
}

interface AddSuccessScreenProps {
  /** Whether running in interactive TUI mode */
  isInteractive: boolean;
  /** Success message (shown in green when complete) */
  message: string;
  /** Optional detail text */
  detail?: string;
  /** Optional custom summary content to display between message and next steps */
  summary?: ReactNode;
  /** Loading state - shows gradient animation instead of success */
  loading?: boolean;
  /** Loading message to show with gradient */
  loadingMessage?: string;
  /** Whether to show the "dev" option (for agent resources) */
  showDevOption?: boolean;
  /** Called when "Add another resource" is selected */
  onAddAnother: () => void;
  /** Called when "Dev" is selected to run agent locally */
  onDev?: () => void;
  /** Called when "Deploy" is selected */
  onDeploy?: () => void;
  /** Called when "return" is selected to go back to main menu, or in non-interactive exit */
  onExit: () => void;
}

export function AddSuccessScreen({
  isInteractive,
  message,
  detail,
  summary,
  loading,
  loadingMessage,
  showDevOption,
  onAddAnother,
  onDev,
  onDeploy,
  onExit,
}: AddSuccessScreenProps) {
  const handleSelect = (step: NextStep) => {
    if (step.command === 'dev') {
      onDev?.();
    } else if (step.command === 'add') {
      onAddAnother();
    } else if (step.command === 'deploy') {
      onDeploy?.();
    }
  };

  // Disable exit while loading
  const handleExit = loading
    ? () => {
        /* noop while loading */
      }
    : onExit;

  // Non-interactive mode - just show success message
  if (!isInteractive) {
    return (
      <Screen title={loading ? 'Add Resource' : 'Success'} onExit={handleExit}>
        <Box flexDirection="column">
          {loading ? (
            <GradientText text={loadingMessage ?? 'Processing...'} />
          ) : (
            <>
              <Text color="green">✓ {message}</Text>
              {summary}
              {detail && <Text>{detail}</Text>}
            </>
          )}
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title={loading ? 'Add Resource' : 'Success'} onExit={handleExit}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {loading ? (
            <GradientText text={loadingMessage ?? 'Processing...'} />
          ) : (
            <>
              <Text color="green">✓ {message}</Text>
              {summary}
              {detail && <Text>{detail}</Text>}
            </>
          )}
        </Box>
        {!loading && (
          <NextSteps
            steps={getAddSuccessSteps(showDevOption ?? false)}
            isInteractive={true}
            onSelect={handleSelect}
            onBack={onExit}
          />
        )}
      </Box>
    </Screen>
  );
}
