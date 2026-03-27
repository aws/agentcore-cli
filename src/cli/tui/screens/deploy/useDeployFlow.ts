import { ConfigIO } from '../../../../lib';
import type { CdkToolkitWrapper, DeployMessage, SwitchableIoHost } from '../../../cdk/toolkit-lib';
import {
  buildDeployedState,
  getStackOutputs,
  parseAgentOutputs,
  parseEvaluatorOutputs,
  parseGatewayOutputs,
  parseMemoryOutputs,
  parseOnlineEvalOutputs,
  parsePolicyEngineOutputs,
  parsePolicyOutputs,
} from '../../../cloudformation';
import { getErrorMessage, isChangesetInProgressError, isExpiredTokenError } from '../../../errors';
import { ExecLogger } from '../../../logging';
import { performStackTeardown, setupTransactionSearch } from '../../../operations/deploy';
import { getGatewayTargetStatuses } from '../../../operations/deploy/gateway-status';
import {
  type StackDiffSummary,
  type Step,
  areStepsComplete,
  hasStepError,
  parseDiffResult,
  parseStackDiff,
} from '../../components';
import { type MissingCredential, type PreflightContext, useCdkPreflight } from '../../hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type DeployPhase =
  | 'idle'
  | 'running'
  | 'teardown-confirm'
  | 'credentials-prompt'
  | 'bootstrap-confirm'
  | 'deploying'
  | 'complete'
  | 'error';

const MAX_OUTPUT_POLL_ATTEMPTS = 10;
const OUTPUT_POLL_DELAY_MS = 1500;

/** Optional pre-synthesized context from plan command */
export interface PreSynthesized {
  cdkToolkitWrapper: CdkToolkitWrapper;
  context: PreflightContext;
  stackNames: string[];
  switchableIoHost?: SwitchableIoHost;
  identityKmsKeyArn?: string;
  allCredentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>;
}

interface DeployFlowOptions {
  /** Skip preflight and use pre-synthesized context (from plan command) */
  preSynthesized?: PreSynthesized;
  /** Whether running in interactive TUI mode - affects error message verbosity */
  isInteractive?: boolean;
  /** Run CDK diff instead of deploy */
  diffMode?: boolean;
}

interface DeployFlowState {
  phase: DeployPhase;
  steps: Step[];
  context: PreflightContext | null;
  deployOutput: string | null;
  deployMessages: DeployMessage[];
  stackOutputs: Record<string, string>;
  targetStatuses: { name: string; status: string }[];
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
  /** Parsed diff summaries per stack */
  diffSummaries: StackDiffSummary[];
  /** Number of stacks with changes (from overall diff result) */
  numStacksWithChanges?: number;
  /** Notes to display after successful deploy (e.g., transaction search info) */
  deployNotes: string[];
  /** Whether an on-demand diff is currently running */
  isDiffLoading: boolean;
  /** Request an on-demand diff (lazy: runs once, caches result) */
  requestDiff: () => void;
  startDeploy: () => void;
  confirmTeardown: () => void;
  cancelTeardown: () => void;
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
  const { preSynthesized, isInteractive = false, diffMode = false } = options;
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
  const allCredentials = preSynthesized?.allCredentials ?? preflight.allCredentials;

  const [publishAssetsStep, setPublishAssetsStep] = useState<Step>({ label: 'Publish assets', status: 'pending' });
  const [deployStep, setDeployStep] = useState<Step>({ label: 'Deploy to AWS', status: 'pending' });
  const [diffStep, setDiffStep] = useState<Step>({ label: 'Run CDK diff', status: 'pending' });
  const [diffSummaries, setDiffSummaries] = useState<StackDiffSummary[]>([]);
  const [numStacksWithChanges, setNumStacksWithChanges] = useState<number | undefined>();
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [deployNotes, setDeployNotes] = useState<string[]>([]);
  const isDiffRunningRef = useRef(false);
  const [deployOutput, setDeployOutput] = useState<string | null>(null);
  const [deployMessages, setDeployMessages] = useState<DeployMessage[]>([]);
  const [stackOutputs, setStackOutputs] = useState<Record<string, string>>({});
  const [targetStatuses, setTargetStatuses] = useState<{ name: string; status: string }[]>([]);
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

  /** Run diff on-demand (lazy: runs once, caches result). Safe to call anytime after synth. */
  const requestDiff = useCallback(() => {
    if (diffSummaries.length > 0 || isDiffRunningRef.current) return;
    if (!cdkToolkitWrapper) return;

    isDiffRunningRef.current = true;
    setIsDiffLoading(true);

    const run = async () => {
      switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
        logger.logDiff(code, message);
        if (code === 'CDK_TOOLKIT_I4002') {
          setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
        } else if (code === 'CDK_TOOLKIT_I4001') {
          setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
        }
      });
      switchableIoHost?.setVerbose(true);

      try {
        await cdkToolkitWrapper.diff();
      } catch {
        setDiffSummaries([{ stackName: 'Error', sections: [], hasSecurityChanges: false, totalChanges: 0 }]);
      } finally {
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnRawMessage(null);
        isDiffRunningRef.current = false;
        setIsDiffLoading(false);
      }
    };

    void run();
  }, [cdkToolkitWrapper, diffSummaries.length, switchableIoHost, logger]);

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
    const agentNames = ctx.projectSpec.runtimes?.map((a: { name: string }) => a.name) || [];

    // CDK stream (I5900) only includes outputs without exportName.
    // Per-resource outputs (memory, agent, gateway) use exportName, so we
    // always need DescribeStacks for the full set. Merge stream outputs as a base.
    let outputs = { ...(streamOutputsRef.current ?? {}) };

    for (let attempt = 1; attempt <= MAX_OUTPUT_POLL_ATTEMPTS; attempt += 1) {
      logger.log(`Polling stack outputs (attempt ${attempt}/${MAX_OUTPUT_POLL_ATTEMPTS})...`);
      const apiOutputs = await getStackOutputs(target.region, currentStackName);
      if (Object.keys(apiOutputs).length > 0) {
        outputs = { ...outputs, ...apiOutputs };
        logger.log(`Retrieved ${Object.keys(apiOutputs).length} output(s) from stack`);
        break;
      }
      if (attempt < MAX_OUTPUT_POLL_ATTEMPTS) {
        logger.log(`No outputs yet, retrying in ${OUTPUT_POLL_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, OUTPUT_POLL_DELAY_MS));
      }
    }
    if (Object.keys(outputs).length === 0) {
      throw new Error('Could not retrieve stack outputs after polling. Deployed state will not be recorded.');
    }

    const agents = parseAgentOutputs(outputs, agentNames, currentStackName);

    if (Object.keys(agents).length !== agentNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${agentNames.length - Object.keys(agents).length} agent(s).`,
        'warn'
      );
    }

    // Parse gateway outputs from CDK stack
    let gateways: Record<string, { gatewayId: string; gatewayArn: string }> = {};
    try {
      const projectForGateways = await configIO.readProjectSpec();
      const gatewaySpecs =
        projectForGateways.agentCoreGateways?.reduce(
          (acc: Record<string, unknown>, gateway: { name: string }) => {
            acc[gateway.name] = gateway;
            return acc;
          },
          {} as Record<string, unknown>
        ) ?? {};
      gateways = parseGatewayOutputs(outputs, gatewaySpecs);
    } catch (error) {
      logger.log(`Failed to read gateway configuration: ${getErrorMessage(error)}`, 'warn');
    }

    // Parse memory outputs
    const memoryNames = (ctx.projectSpec.memories ?? []).map((m: { name: string }) => m.name);
    const memories = parseMemoryOutputs(outputs, memoryNames);

    if (memoryNames.length > 0 && Object.keys(memories).length !== memoryNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${memoryNames.length - Object.keys(memories).length} memory(ies).`,
        'warn'
      );
    }

    // Parse evaluator outputs
    const evaluatorNames = (ctx.projectSpec.evaluators ?? []).map((e: { name: string }) => e.name);
    const evaluators = parseEvaluatorOutputs(outputs, evaluatorNames);

    // Parse online eval config outputs
    const onlineEvalNames = (ctx.projectSpec.onlineEvalConfigs ?? []).map((c: { name: string }) => c.name);
    const onlineEvalConfigs = parseOnlineEvalOutputs(outputs, onlineEvalNames);

    // Parse policy engine outputs
    const policyEngineSpecs = ctx.projectSpec.policyEngines ?? [];
    const policyEngineNames = policyEngineSpecs.map((pe: { name: string }) => pe.name);
    const policyEngines = parsePolicyEngineOutputs(outputs, policyEngineNames);

    // Parse policy outputs
    const policySpecs = policyEngineSpecs.flatMap((pe: { name: string; policies: { name: string }[] }) =>
      pe.policies.map(p => ({ engineName: pe.name, policyName: p.name }))
    );
    const policies = parsePolicyOutputs(outputs, policySpecs);

    // Expose outputs to UI
    setStackOutputs(outputs);

    const existingState = await configIO.readDeployedState().catch(() => undefined);
    const deployedState = buildDeployedState({
      targetName: target.name,
      stackName: currentStackName,
      agents,
      gateways,
      existingState,
      identityKmsKeyArn,
      memories,
      evaluators,
      onlineEvalConfigs,
      credentials: Object.keys(allCredentials).length > 0 ? allCredentials : undefined,
      policyEngines,
      policies,
    });
    await configIO.writeDeployedState(deployedState);

    // Query gateway target sync statuses (non-blocking)
    const allStatuses: { name: string; status: string }[] = [];
    for (const [, gateway] of Object.entries(gateways)) {
      const statuses = await getGatewayTargetStatuses(gateway.gatewayId, target.region);
      allStatuses.push(...statuses);
    }
    if (allStatuses.length > 0) {
      setTargetStatuses(allStatuses);
    }
  }, [context, stackNames, logger, identityKmsKeyArn, allCredentials]);

  // Start deploy when preflight completes OR when shouldStartDeploy is set
  useEffect(() => {
    if (diffMode) return; // Diff mode uses its own effect
    const shouldStart = skipPreflight ? shouldStartDeploy : preflight.phase === 'complete';
    if (!shouldStart) return;
    if (deployStep.status !== 'pending') return;
    if (!cdkToolkitWrapper) return;

    const run = async () => {
      // Run diff before deploy to capture pre-deploy differences
      if (!isDiffRunningRef.current) {
        isDiffRunningRef.current = true;
        setIsDiffLoading(true);
        switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
          logger.logDiff(code, message);
          if (code === 'CDK_TOOLKIT_I4002') {
            setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
          } else if (code === 'CDK_TOOLKIT_I4001') {
            setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
          }
        });
        switchableIoHost?.setVerbose(true);
        try {
          await cdkToolkitWrapper.diff();
        } catch {
          // Diff failure is non-fatal — deploy will proceed
        } finally {
          switchableIoHost?.setVerbose(false);
          switchableIoHost?.setOnRawMessage(null);
          isDiffRunningRef.current = false;
          setIsDiffLoading(false);
        }
      }

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

        if (context?.isTeardownDeploy) {
          // After deploying the empty spec, destroy the stack entirely
          const targetName = context.awsTargets[0]?.name;
          if (targetName) {
            const teardown = await performStackTeardown(targetName);
            if (!teardown.success) {
              throw new Error(`Stack teardown failed: ${teardown.error}`);
            }
          }
        } else {
          // Deploy succeeded - persist state
          try {
            await persistDeployedState();
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.log(`Failed to persist deployed state: ${message}`, 'warn');
          }

          // Post-deploy: Enable CloudWatch Transaction Search (non-blocking, silent)
          const agentNames = context?.projectSpec.runtimes?.map((a: { name: string }) => a.name) ?? [];
          const targetRegion = context?.awsTargets[0]?.region;
          const targetAccount = context?.awsTargets[0]?.account;
          const hasGateways = (context?.projectSpec.agentCoreGateways?.length ?? 0) > 0;
          if ((agentNames.length > 0 || hasGateways) && targetRegion && targetAccount) {
            try {
              const tsResult = await setupTransactionSearch({
                region: targetRegion,
                accountId: targetAccount,
                agentNames,
                hasGateways,
              });
              if (tsResult.error) {
                logger.log(`Transaction search setup warning: ${tsResult.error}`, 'warn');
              } else {
                setDeployNotes(prev => [
                  ...prev,
                  'Transaction search enabled. It takes ~10 minutes for transaction search to be fully active and for traces from invocations to be indexed.',
                ]);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              logger.log(`Transaction search setup failed: ${message}`, 'warn');
            }
          }
        }

        logger.endStep('success');
        logger.finalize(true);
        setDeployOutput(`Deployed ${stackNames.length} stack(s): ${stackNames.join(', ')}`);
        // Mark both steps as success (in case CFn events were never received)
        setPublishAssetsStep(prev => ({ ...prev, status: 'success' }));
        setDeployStep(prev => ({ ...prev, status: 'success' }));
      } catch (err) {
        const errorMsg = getErrorMessage(err);

        // Log additional context for changeset errors
        if (isChangesetInProgressError(err)) {
          logger.log('Changeset conflict detected - another deployment may be in progress', 'warn');
          logger.log('The CDK wrapper will retry automatically with exponential backoff', 'info');
        }

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
    context?.isTeardownDeploy,
    context?.awsTargets,
    context?.projectSpec.runtimes,
    diffMode,
  ]);

  // Start diff when preflight completes (diff mode only)
  useEffect(() => {
    if (!diffMode) return;
    const shouldStart = skipPreflight ? shouldStartDeploy : preflight.phase === 'complete';
    if (!shouldStart) return;
    if (diffStep.status !== 'pending') return;
    if (!cdkToolkitWrapper) return;

    const run = async () => {
      setDiffStep(prev => ({ ...prev, status: 'running' }));
      setShouldStartDeploy(false);
      setDiffSummaries([]);
      logger.startStep('Run CDK diff');

      switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
        logger.logDiff(code, message);
        if (code === 'CDK_TOOLKIT_I4002') {
          setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
        } else if (code === 'CDK_TOOLKIT_I4001') {
          setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
        }
      });
      switchableIoHost?.setVerbose(true);

      try {
        await cdkToolkitWrapper.diff();
        logger.endStep('success');
        logger.finalize(true);
        setDiffStep(prev => ({ ...prev, status: 'success' }));
      } catch (err) {
        const errorMsg = getErrorMessage(err);
        logger.endStep('error', errorMsg);
        logger.finalize(false);

        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }

        setDiffStep(prev => ({
          ...prev,
          status: 'error',
          error: logger.getFailureMessage('Run CDK diff'),
        }));
      } finally {
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnRawMessage(null);
        void cdkToolkitWrapper.dispose();
      }
    };

    void run();
  }, [
    diffMode,
    preflight.phase,
    cdkToolkitWrapper,
    diffStep.status,
    logger,
    skipPreflight,
    shouldStartDeploy,
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

  const steps = useMemo(() => {
    if (diffMode) {
      return skipPreflight ? [diffStep] : [...preflight.steps, diffStep];
    }
    return skipPreflight ? [publishAssetsStep, deployStep] : [...preflight.steps, publishAssetsStep, deployStep];
  }, [preflight.steps, publishAssetsStep, deployStep, diffStep, skipPreflight, diffMode]);

  const phase: DeployPhase = useMemo(() => {
    const activeStep = diffMode ? diffStep : deployStep;

    if (skipPreflight) {
      if (!shouldStartDeploy && activeStep.status === 'pending') {
        return 'idle';
      }
      if (activeStep.status === 'error') {
        return 'error';
      }
      if (activeStep.status === 'success') {
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
    if (preflight.phase === 'teardown-confirm') {
      return 'teardown-confirm';
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
    if (activeStep.status === 'error') {
      return 'error';
    }
    if (activeStep.status === 'success') {
      return 'complete';
    }
    return 'deploying';
  }, [preflight.phase, deployStep, diffStep, skipPreflight, shouldStartDeploy, diffMode]);

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
    diffSummaries,
    numStacksWithChanges,
    deployNotes,
    isDiffLoading,
    requestDiff,
    stackOutputs,
    targetStatuses,
    hasError,
    hasTokenExpiredError: combinedTokenExpiredError,
    hasCredentialsError: preflight.hasCredentialsError,
    isComplete,
    hasStartedCfn,
    logFilePath: logger.logFilePath,
    missingCredentials: preflight.missingCredentials,
    startDeploy,
    confirmTeardown: preflight.confirmTeardown,
    cancelTeardown: preflight.cancelTeardown,
    confirmBootstrap: preflight.confirmBootstrap,
    skipBootstrap: preflight.skipBootstrap,
    clearTokenExpiredError: clearAllTokenExpiredErrors,
    clearCredentialsError: clearAllCredentialsErrors,
    useEnvLocalCredentials: preflight.useEnvLocalCredentials,
    useManualCredentials: preflight.useManualCredentials,
    skipCredentials: preflight.skipCredentials,
  };
}
