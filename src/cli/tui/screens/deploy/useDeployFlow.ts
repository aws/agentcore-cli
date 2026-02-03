import { ConfigIO } from '../../../../lib';
import type { CdkToolkitWrapper, DeployMessage, SwitchableIoHost } from '../../../cdk/toolkit-lib';
import { buildDeployedState, getStackOutputs, parseAgentOutputs } from '../../../cloudformation';
import { getErrorMessage, isExpiredTokenError } from '../../../errors';
import { ExecLogger } from '../../../logging';
import { type Step, areStepsComplete, hasStepError } from '../../components';
import { type MissingCredential, type PreflightContext, useCdkPreflight } from '../../hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type DeployPhase = 'idle' | 'running' | 'credentials-prompt' | 'bootstrap-confirm' | 'deploying' | 'complete' | 'error';

const MAX_OUTPUT_POLL_ATTEMPTS = 10;
const OUTPUT_POLL_DELAY_MS = 1500;

/** Optional pre-synthesized context from plan command */
export interface PreSynthesized {
  cdkToolkitWrapper: CdkToolkitWrapper;
  context: PreflightContext;
  stackNames: string[];
  switchableIoHost?: SwitchableIoHost;
  identityKmsKeyArn?: string;
}

interface DeployFlowOptions {
  /** Skip preflight and use pre-synthesized context (from plan command) */
  preSynthesized?: PreSynthesized;
  /** Whether running in interactive TUI mode - affects error message verbosity */
  isInteractive?: boolean;
}

interface DeployFlowState {
  phase: DeployPhase;
  steps: Step[];
  context: PreflightContext | null;
  deployOutput: string | null;
  deployMessages: DeployMessage[];
  stackOutputs: Record<string, string>;
  hasError: boolean;
  /** True if the error is specifically due to expired/invalid AWS credentials */
  hasTokenExpiredError: boolean;
  /** True if the error is due to missing AWS credentials (not configured) */
  hasCredentialsError: boolean;
  isComplete: boolean;
  /** True if CloudFormation has started (received first resource event) */
  hasStartedCfn: boolean;
  logFilePath: string;
  /** Missing credentials that need to be provided */
  missingCredentials: MissingCredential[];
  startDeploy: () => void;
  confirmBootstrap: () => void;
  skipBootstrap: () => void;
  /** Reset token expired state (called after user re-authenticates) */
  clearTokenExpiredError: () => void;
  /** Reset credentials error state (called after user configures credentials) */
  clearCredentialsError: () => void;
  /** Called when user chooses to use credentials from .env.local */
  useEnvLocalCredentials: () => void;
  /** Called when user enters credentials manually */
  useManualCredentials: (credentials: Record<string, string>) => void;
  /** Called when user chooses to skip credential setup */
  skipCredentials: () => void;
}

export function useDeployFlow(options: DeployFlowOptions = {}): DeployFlowState {
  const { preSynthesized, isInteractive = false } = options;
  const skipPreflight = !!preSynthesized;

  // Create logger once for the entire deploy flow
  const [logger] = useState(() => new ExecLogger({ command: 'deploy' }));

  // Always call the hook (React rules), but we won't use it when preSynthesized is provided
  const preflight = useCdkPreflight({ logger, isInteractive });

  // Use pre-synthesized values when provided, otherwise use preflight values
  const cdkToolkitWrapper = preSynthesized?.cdkToolkitWrapper ?? preflight.cdkToolkitWrapper;
  const context = preSynthesized?.context ?? preflight.context;
  const stackNames = preSynthesized?.stackNames ?? preflight.stackNames;
  const switchableIoHost = preSynthesized?.switchableIoHost ?? preflight.switchableIoHost;
  const identityKmsKeyArn = preSynthesized?.identityKmsKeyArn ?? preflight.identityKmsKeyArn;

  const [publishAssetsStep, setPublishAssetsStep] = useState<Step>({ label: 'Publish assets', status: 'pending' });
  const [deployStep, setDeployStep] = useState<Step>({ label: 'Deploy to AWS', status: 'pending' });
  const [deployOutput, setDeployOutput] = useState<string | null>(null);
  const [deployMessages, setDeployMessages] = useState<DeployMessage[]>([]);
  const [stackOutputs, setStackOutputs] = useState<Record<string, string>>({});
  const [shouldStartDeploy, setShouldStartDeploy] = useState(false);
  const [hasTokenExpiredError, setHasTokenExpiredError] = useState(false);
  // Track if CloudFormation has started (received first resource event)
  const [hasStartedCfn, setHasStartedCfn] = useState(false);
  // Ref version for use in callbacks (avoids stale closure issues)
  const hasReceivedCfnEvent = useRef(false);
  // Ref to capture outputs from I5900 stream message (for immediate access in persistDeployedState)
  const streamOutputsRef = useRef<Record<string, string> | null>(null);

  const startDeploy = useCallback(() => {
    setPublishAssetsStep({ label: 'Publish assets', status: 'pending' });
    setDeployStep({ label: 'Deploy to AWS', status: 'pending' });
    setDeployOutput(null);
    setHasTokenExpiredError(false); // Reset token expired state when retrying
    setHasStartedCfn(false);
    hasReceivedCfnEvent.current = false;
    if (skipPreflight) {
      setShouldStartDeploy(true);
    } else {
      void preflight.startPreflight();
    }
  }, [preflight, skipPreflight]);

  /**
   * Persist deployed state after successful deployment.
   * Uses outputs from CDK stream (I5900) if available, falls back to DescribeStacks API.
   */
  const persistDeployedState = useCallback(async () => {
    const ctx = context;
    const currentStackName = stackNames[0];
    const target = ctx?.awsTargets[0];

    if (!ctx || !currentStackName || !target) return;

    const configIO = new ConfigIO();
    const agentNames = ctx.projectSpec.agents.map((a: { name: string }) => a.name);

    // Try to get outputs from CDK stream first (immediate, no API call)
    let outputs = streamOutputsRef.current ?? {};

    // Fallback to DescribeStacks if stream outputs not available
    if (Object.keys(outputs).length === 0) {
      logger.log('Stream outputs not available, falling back to DescribeStacks API');
      for (let attempt = 1; attempt <= MAX_OUTPUT_POLL_ATTEMPTS; attempt += 1) {
        outputs = await getStackOutputs(target.region, currentStackName);
        if (Object.keys(outputs).length > 0) {
          break;
        }
        if (attempt < MAX_OUTPUT_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, OUTPUT_POLL_DELAY_MS));
        }
      }
    }

    const agents = parseAgentOutputs(outputs, agentNames, currentStackName);

    if (Object.keys(agents).length !== agentNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${agentNames.length - Object.keys(agents).length} agent(s).`,
        'warn'
      );
    }

    // Expose outputs to UI
    setStackOutputs(outputs);

    const existingState = await configIO.readDeployedState().catch(() => undefined);
    const deployedState = buildDeployedState(target.name, currentStackName, agents, existingState, identityKmsKeyArn);
    await configIO.writeDeployedState(deployedState);
  }, [context, stackNames, logger, identityKmsKeyArn]);

  // Start deploy when preflight completes OR when shouldStartDeploy is set
  useEffect(() => {
    const shouldStart = skipPreflight ? shouldStartDeploy : preflight.phase === 'complete';
    if (!shouldStart) return;
    if (deployStep.status !== 'pending') return;
    if (!cdkToolkitWrapper) return;

    const run = async () => {
      setPublishAssetsStep(prev => ({ ...prev, status: 'running' }));
      setShouldStartDeploy(false);
      setDeployMessages([]); // Clear previous messages
      streamOutputsRef.current = null; // Clear previous stream outputs
      logger.startStep('Publish assets');

      // Set up raw message callback to log ALL CDK output
      switchableIoHost?.setOnRawMessage((code, level, message) => {
        logger.log(`[${level}] ${code}: ${message}`);
      });

      // Set up filtered message callback for TUI display
      switchableIoHost?.setOnMessage(msg => {
        setDeployMessages(prev => [...prev, msg]);
        // When we receive the first CloudFormation event with progress, mark assets as published
        if (!hasReceivedCfnEvent.current && msg.progress) {
          hasReceivedCfnEvent.current = true;
          setHasStartedCfn(true);
          logger.endStep('success');
          logger.startStep('Deploy to AWS');
          setPublishAssetsStep(prev => ({ ...prev, status: 'success' }));
          setDeployStep(prev => ({ ...prev, status: 'running' }));
        }
        // Capture outputs from I5900 for immediate use in persistDeployedState
        if (msg.code === 'CDK_TOOLKIT_I5900' && msg.outputs) {
          streamOutputsRef.current = msg.outputs;
        }
      });

      // Enable verbose output for deploy - this captures CDK progress messages
      switchableIoHost?.setVerbose(true);

      try {
        // Run deploy - toolkit-lib handles CloudFormation orchestration
        // Output goes to stdout via the switchable ioHost
        await cdkToolkitWrapper.deploy();

        // Deploy succeeded - persist state
        try {
          await persistDeployedState();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          logger.log(`Failed to persist deployed state: ${message}`, 'warn');
        }

        logger.endStep('success');
        logger.finalize(true);
        setDeployOutput(`Deployed ${stackNames.length} stack(s): ${stackNames.join(', ')}`);
        // Mark both steps as success (in case CFn events were never received)
        setPublishAssetsStep(prev => ({ ...prev, status: 'success' }));
        setDeployStep(prev => ({ ...prev, status: 'success' }));
      } catch (err) {
        const errorMsg = getErrorMessage(err);
        logger.endStep('error', errorMsg);
        logger.finalize(false);

        // Check if the error is due to expired/invalid credentials
        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }

        // Mark the appropriate step as error based on whether CFn started
        if (hasReceivedCfnEvent.current) {
          setDeployStep(prev => ({
            ...prev,
            status: 'error',
            error: logger.getFailureMessage('Deploy to AWS'),
          }));
        } else {
          setPublishAssetsStep(prev => ({
            ...prev,
            status: 'error',
            error: logger.getFailureMessage('Publish assets'),
          }));
        }
      } finally {
        // Disable verbose output and clear callback after deploy
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnMessage(null);
        // Dispose CDK toolkit to release lock files
        void cdkToolkitWrapper.dispose();
      }
    };

    void run();
  }, [
    preflight.phase,
    cdkToolkitWrapper,
    stackNames,
    deployStep.status,
    logger,
    skipPreflight,
    shouldStartDeploy,
    persistDeployedState,
    switchableIoHost,
  ]);

  // Finalize logger and dispose toolkit when preflight fails
  useEffect(() => {
    if (skipPreflight) return;
    if (preflight.phase === 'error') {
      logger.finalize(false);
      void preflight.cdkToolkitWrapper?.dispose();
    }
  }, [preflight.phase, preflight.cdkToolkitWrapper, logger, skipPreflight]);

  const steps = useMemo(
    () => (skipPreflight ? [publishAssetsStep, deployStep] : [...preflight.steps, publishAssetsStep, deployStep]),
    [preflight.steps, publishAssetsStep, deployStep, skipPreflight]
  );

  const phase: DeployPhase = useMemo(() => {
    if (skipPreflight) {
      if (!shouldStartDeploy && deployStep.status === 'pending') {
        return 'idle';
      }
      if (deployStep.status === 'error') {
        return 'error';
      }
      if (deployStep.status === 'success') {
        return 'complete';
      }
      return 'deploying';
    }

    if (preflight.phase === 'idle') {
      return 'idle';
    }
    if (preflight.phase === 'error') {
      return 'error';
    }
    if (preflight.phase === 'credentials-prompt') {
      return 'credentials-prompt';
    }
    if (preflight.phase === 'bootstrap-confirm') {
      return 'bootstrap-confirm';
    }
    if (preflight.phase === 'running' || preflight.phase === 'bootstrapping' || preflight.phase === 'identity-setup') {
      return 'running';
    }
    if (deployStep.status === 'error') {
      return 'error';
    }
    if (deployStep.status === 'success') {
      return 'complete';
    }
    return 'deploying';
  }, [preflight.phase, deployStep.status, skipPreflight, shouldStartDeploy]);

  const hasError = hasStepError(steps);
  const isComplete = areStepsComplete(steps);

  // Combine token expired errors from both preflight and deploy phases
  const combinedTokenExpiredError = hasTokenExpiredError || preflight.hasTokenExpiredError;

  const clearAllTokenExpiredErrors = useCallback(() => {
    setHasTokenExpiredError(false);
    preflight.clearTokenExpiredError();
  }, [preflight]);

  const clearAllCredentialsErrors = useCallback(() => {
    preflight.clearCredentialsError();
  }, [preflight]);

  return {
    phase,
    steps,
    context,
    deployOutput,
    deployMessages,
    stackOutputs,
    hasError,
    hasTokenExpiredError: combinedTokenExpiredError,
    hasCredentialsError: preflight.hasCredentialsError,
    isComplete,
    hasStartedCfn,
    logFilePath: logger.logFilePath,
    missingCredentials: preflight.missingCredentials,
    startDeploy,
    confirmBootstrap: preflight.confirmBootstrap,
    skipBootstrap: preflight.skipBootstrap,
    clearTokenExpiredError: clearAllTokenExpiredErrors,
    clearCredentialsError: clearAllCredentialsErrors,
    useEnvLocalCredentials: preflight.useEnvLocalCredentials,
    useManualCredentials: preflight.useManualCredentials,
    skipCredentials: preflight.skipCredentials,
  };
}
