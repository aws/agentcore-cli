import {
  AwsTargetConfigUI,
  ConfirmPrompt,
  CredentialSourcePrompt,
  DeployStatus,
  LogLink,
  type NextStep,
  NextSteps,
  Screen,
  StepProgress,
  getAwsConfigHelpText,
} from '../../components';
import { BOOTSTRAP, HELP_TEXT } from '../../constants';
import { useAwsTargetConfig } from '../../hooks';
import { InvokeScreen } from '../invoke';
import { type PreSynthesized, useDeployFlow } from './useDeployFlow';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface DeployScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  autoConfirm?: boolean;
  /** Navigate to another command (interactive mode only) */
  onNavigate?: (command: string) => void;
  /** Skip preflight and use pre-synthesized context (from plan command) */
  preSynthesized?: PreSynthesized;
}

/** Next steps shown after successful deployment */
const DEPLOY_NEXT_STEPS: NextStep[] = [
  { command: 'invoke', label: 'Test your agent' },
  { command: 'status', label: 'View deployment status' },
];

export function DeployScreen({ isInteractive, onExit, autoConfirm, onNavigate, preSynthesized }: DeployScreenProps) {
  const awsConfig = useAwsTargetConfig();
  const [showInvoke, setShowInvoke] = useState(false);
  const {
    phase,
    steps,
    context,
    deployOutput,
    deployMessages,
    hasError,
    hasTokenExpiredError,
    hasCredentialsError,
    isComplete,
    hasStartedCfn,
    logFilePath,
    missingCredentials,
    startDeploy,
    confirmBootstrap,
    skipBootstrap,
    clearTokenExpiredError,
    clearCredentialsError,
    useEnvLocalCredentials,
    useManualCredentials,
    skipCredentials,
  } = useDeployFlow({ preSynthesized, isInteractive });
  const allSuccess = !hasError && isComplete;
  const skipPreflight = !!preSynthesized;

  // Auto-start deploy when AWS target is configured (or immediately when preSynthesized)
  useEffect(() => {
    if (phase === 'idle' && (skipPreflight || awsConfig.isConfigured)) {
      startDeploy();
    }
  }, [phase, awsConfig.isConfigured, startDeploy, skipPreflight]);

  // Auto-confirm bootstrap when autoConfirm is enabled
  useEffect(() => {
    if (autoConfirm && phase === 'bootstrap-confirm') {
      confirmBootstrap();
    }
  }, [autoConfirm, phase, confirmBootstrap]);

  // Trigger token-expired recovery flow when deploy fails with token error
  useEffect(() => {
    if (hasTokenExpiredError && awsConfig.phase !== 'token-expired') {
      awsConfig.triggerTokenExpired();
    }
  }, [hasTokenExpiredError, awsConfig]);

  // Trigger credentials recovery flow when deploy fails with credentials error (interactive mode only)
  useEffect(() => {
    if (isInteractive && hasCredentialsError && awsConfig.phase !== 'choice') {
      awsConfig.triggerNoCredentials();
    }
  }, [isInteractive, hasCredentialsError, awsConfig]);

  // Exit in non-interactive mode when there's an error
  useEffect(() => {
    if (!isInteractive && hasError && phase === 'error') {
      onExit();
    }
  }, [isInteractive, hasError, phase, onExit]);

  // Auto-exit in non-interactive mode on success
  useEffect(() => {
    if (!isInteractive && allSuccess) {
      onExit();
    }
  }, [isInteractive, allSuccess, onExit]);

  // Show invoke screen (only in interactive mode when selected from next steps)
  if (showInvoke && isInteractive) {
    return <InvokeScreen isInteractive={true} onExit={onExit} />;
  }

  // Token expired recovery flow - show re-authentication options
  if (awsConfig.phase === 'token-expired') {
    const handleExit = () => {
      clearTokenExpiredError();
      awsConfig.resetFromTokenExpired();
      onExit();
    };

    return (
      <Screen title="AgentCore Deploy" onExit={handleExit} helpText={getAwsConfigHelpText(awsConfig.phase)}>
        <AwsTargetConfigUI config={awsConfig} onExit={handleExit} isActive={true} />
      </Screen>
    );
  }

  // Credentials error recovery flow - show credential setup options (interactive mode)
  if (awsConfig.phase === 'choice' && hasCredentialsError) {
    const handleExit = () => {
      clearCredentialsError();
      awsConfig.resetFromChoice();
      onExit();
    };

    return (
      <Screen title="AgentCore Deploy" onExit={handleExit} helpText={getAwsConfigHelpText(awsConfig.phase)}>
        <StepProgress steps={steps} />
        <Box marginTop={1}>
          <AwsTargetConfigUI config={awsConfig} onExit={handleExit} isActive={true} />
        </Box>
      </Screen>
    );
  }

  // AWS target configuration phase (skip when preSynthesized - we already have context)
  if (!skipPreflight && !awsConfig.isConfigured) {
    return (
      <Screen title="AgentCore Deploy" onExit={onExit} helpText={getAwsConfigHelpText(awsConfig.phase)}>
        <AwsTargetConfigUI config={awsConfig} onExit={onExit} isActive={true} />
      </Screen>
    );
  }

  // Credentials prompt phase
  if (phase === 'credentials-prompt') {
    return (
      <CredentialSourcePrompt
        missingCredentials={missingCredentials}
        onUseEnvLocal={useEnvLocalCredentials}
        onManualEntry={useManualCredentials}
        onSkip={skipCredentials}
      />
    );
  }

  // Bootstrap confirmation phase (only shown if not auto-confirming)
  if (phase === 'bootstrap-confirm' && !autoConfirm) {
    return (
      <ConfirmPrompt
        message={BOOTSTRAP.TITLE}
        detail={BOOTSTRAP.EXPLAINER}
        onConfirm={confirmBootstrap}
        onCancel={skipBootstrap}
      />
    );
  }

  const targetDisplay = context?.awsTargets.map(t => `${t.region}:${t.account}`).join(', ');

  // Show deploy status box once CloudFormation has started (after asset publishing)
  const showDeployStatus = hasStartedCfn || isComplete;

  // Filter out "Deploy to AWS" step when deploy status box is showing
  const displaySteps = showDeployStatus ? steps.filter(s => s.label !== 'Deploy to AWS') : steps;

  const headerContent = context && (
    <Box flexDirection="column">
      <Box>
        <Text>Project: </Text>
        <Text color="green">{context.projectSpec.name}</Text>
      </Box>
      {targetDisplay && (
        <Box>
          <Text>Target: </Text>
          <Text color="yellow">{targetDisplay}</Text>
        </Box>
      )}
    </Box>
  );

  const helpText = allSuccess && isInteractive ? HELP_TEXT.NAVIGATE_SELECT : HELP_TEXT.EXIT;

  return (
    <Screen title="AgentCore Deploy" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <StepProgress steps={displaySteps} />

      {/* Show deploy status when deploying or complete */}
      {showDeployStatus && (
        <Box marginTop={1}>
          <DeployStatus messages={deployMessages} isComplete={isComplete} hasError={hasError} />
        </Box>
      )}

      {allSuccess && deployOutput && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">{deployOutput}</Text>
        </Box>
      )}

      {logFilePath && (
        <Box marginTop={1}>
          <LogLink filePath={logFilePath} />
        </Box>
      )}

      {allSuccess && (
        <NextSteps
          steps={DEPLOY_NEXT_STEPS}
          isInteractive={isInteractive}
          onSelect={step => {
            if (step.command === 'invoke') {
              setShowInvoke(true);
            } else if (onNavigate) {
              onNavigate(step.command);
            }
          }}
          onBack={onExit}
          isActive={allSuccess && !showInvoke}
        />
      )}
    </Screen>
  );
}
