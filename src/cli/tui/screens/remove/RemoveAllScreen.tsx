import { ConfirmPrompt, type NextStep, NextSteps, Screen, StepProgress } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useRemoveFlow } from './useRemoveFlow';
import { Box, Text, useInput } from 'ink';
import { useEffect } from 'react';

interface RemoveAllScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive?: boolean;
  force?: boolean;
  dryRun?: boolean;
  onExit: () => void;
  /** Callback when user selects a next step command (e.g. deploy) */
  onNavigate?: (command: string) => void;
}

const REMOVE_ALL_NEXT_STEPS: NextStep[] = [{ command: 'deploy', label: 'Deploy changes to AWS' }];

export function RemoveAllScreen({
  isInteractive = true,
  force = false,
  dryRun = false,
  onExit,
  onNavigate,
}: RemoveAllScreenProps) {
  const flow = useRemoveFlow({ force, dryRun });

  // Auto-exit in non-interactive mode when complete
  useEffect(() => {
    if (!isInteractive && (flow.phase === 'complete' || flow.phase === 'not-found' || flow.phase === 'dry-run')) {
      onExit();
    }
  }, [isInteractive, flow.phase, onExit]);

  // Handle key press for complete phase (only when NextSteps is not shown)
  const showNextSteps = flow.phase === 'complete' && !flow.hasError && flow.hasDeployedResources;
  useInput(
    (_input, key) => {
      if (key.return || _input === ' ') {
        onExit();
      }
    },
    { isActive: flow.phase === 'complete' && !showNextSteps }
  );

  // Show confirmation prompt for non-force mode
  if (flow.phase === 'confirm' && !force) {
    const detail =
      flow.itemsToRemove.length > 0
        ? `This will reset:\n${flow.itemsToRemove.map(item => `• ${item}`).join('\n')}\n\nAll agent definitions and configurations will be cleared.`
        : undefined;

    return (
      <ConfirmPrompt
        message="Reset all AgentCore schemas to empty state?"
        detail={detail}
        onConfirm={flow.confirmRemoval}
        onCancel={onExit}
        showInput={true}
        inputPrompt="Confirm reset (y/n)"
      />
    );
  }

  return (
    <Screen
      title="Reset AgentCore Schemas"
      onExit={onExit}
      helpText={flow.phase === 'complete' ? HELP_TEXT.EXIT : HELP_TEXT.EXIT}
    >
      <Box flexDirection="column" gap={1}>
        {flow.phase === 'checking' && <Text dimColor>Checking for AgentCore project...</Text>}

        {flow.phase === 'not-found' && (
          <Box flexDirection="column" gap={1}>
            <Text color="yellow">No AgentCore project found in current directory.</Text>
            <Text dimColor>Nothing to reset.</Text>
          </Box>
        )}

        {flow.phase === 'dry-run' && (
          <Box flexDirection="column" gap={1}>
            <Text color="cyan">Dry run - showing what would be reset:</Text>
            <Box marginLeft={2} flexDirection="column">
              {flow.itemsToRemove.map((item, index) => (
                <Text key={index} dimColor>
                  • {item}
                </Text>
              ))}
            </Box>
          </Box>
        )}

        {flow.phase === 'removing' && (
          <Box flexDirection="column" gap={1}>
            <Text>Resetting AgentCore schemas...</Text>
            <StepProgress steps={flow.steps} />
          </Box>
        )}

        {flow.phase === 'complete' && (
          <Box flexDirection="column" gap={1}>
            {flow.hasError ? (
              <>
                <Text color="red">Reset completed with errors</Text>
                <Text dimColor>Some schemas may need manual cleanup</Text>
              </>
            ) : (
              <>
                <Text color="green">AgentCore schemas reset successfully</Text>
                <Text dimColor>Your source code has not been modified.</Text>
                {flow.hasDeployedResources ? (
                  <NextSteps
                    steps={REMOVE_ALL_NEXT_STEPS}
                    isInteractive={isInteractive}
                    onSelect={step => onNavigate?.(step.command)}
                    onBack={onExit}
                    isActive={showNextSteps}
                  />
                ) : (
                  <Text dimColor>All schemas have been reset to empty state.</Text>
                )}
              </>
            )}
          </Box>
        )}
      </Box>
    </Screen>
  );
}
