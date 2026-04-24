import { ConfigIO, SecureCredentials } from '../../../lib';
import type { DeployedState } from '../../../schema';
import { applyTargetRegionToEnv } from '../../aws';
import { AwsCredentialsError, validateAwsCredentials } from '../../aws/account';
import { type CdkToolkitWrapper, type SwitchableIoHost, createSwitchableIoHost } from '../../cdk/toolkit-lib';
import { getErrorMessage, isExpiredTokenError, isNoCredentialsError } from '../../errors';
import type { ExecLogger } from '../../logging';
import {
  type MissingCredential,
  type PreflightContext,
  bootstrapEnvironment,
  buildCdkProject,
  checkBootstrapNeeded,
  checkDependencyVersions,
  checkStackDeployability,
  formatError,
  getAllCredentials,
  hasIdentityApiProviders,
  hasIdentityOAuthProviders,
  setupApiKeyProviders,
  setupOAuth2Providers,
  synthesizeCdk,
  validateProject,
} from '../../operations/deploy';
import type { Step } from '../components';
import * as path from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type PreflightPhase =
  | 'idle'
  | 'running'
  | 'teardown-confirm'
  | 'credentials-prompt'
  | 'identity-setup'
  | 'bootstrap-confirm'
  | 'bootstrapping'
  | 'complete'
  | 'error';

export type { PreflightContext, MissingCredential };

interface BootstrapContext {
  toolkitWrapper: CdkToolkitWrapper;
  target: NonNullable<PreflightContext['awsTargets'][0]>;
}

export interface PreflightOptions {
  /** Logger for capturing step execution */
  logger: ExecLogger;
  /** Whether running in interactive TUI mode - affects error message verbosity */
  isInteractive?: boolean;
  /** Skip identity provider check (for plan command which only synthesizes) */
  skipIdentityCheck?: boolean;
}

export interface PreflightResult {
  phase: PreflightPhase;
  steps: Step[];
  context: PreflightContext | null;
  cdkToolkitWrapper: CdkToolkitWrapper | null;
  stackNames: string[];
  /** Switchable ioHost - call setVerbose(true) before deploy for CLI output */
  switchableIoHost: SwitchableIoHost;
  /** True if preflight failed due to expired/invalid AWS credentials */
  hasTokenExpiredError: boolean;
  /** True if preflight failed due to missing AWS credentials (not configured) */
  hasCredentialsError: boolean;
  /** Missing credentials that need to be provided */
  missingCredentials: MissingCredential[];
  /** KMS key ARN used for identity token vault encryption */
  identityKmsKeyArn?: string;
  /** Credential ARNs (API key + OAuth) from pre-deploy setup */
  allCredentials: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>;
  startPreflight: () => Promise<void>;
  confirmTeardown: () => void;
  cancelTeardown: () => void;
  confirmBootstrap: () => void;
  skipBootstrap: () => void;
  /** Clear the token expired error state */
  clearTokenExpiredError: () => void;
  /** Clear the credentials error state */
  clearCredentialsError: () => void;
  /** Called when user chooses to use credentials from .env.local */
  useEnvLocalCredentials: () => void;
  /** Called when user enters credentials manually */
  useManualCredentials: (credentials: Record<string, string>) => void;
  /** Called when user chooses to skip credential setup */
  skipCredentials: () => void;
}

// Step indices for base preflight steps (always present)
const STEP_VALIDATE = 0;
const STEP_DEPS = 1;
const STEP_BUILD = 2;
// Note: Identity steps are inserted at index 3+ when needed, shifting synth and stack status down.
// Use findStepIndex() to locate synth and stack status dynamically.

const BASE_PREFLIGHT_STEPS: Step[] = [
  { label: 'Validate project', status: 'pending' },
  { label: 'Check dependencies', status: 'pending' },
  { label: 'Build CDK project', status: 'pending' },
  { label: 'Synthesize CloudFormation', status: 'pending' },
  { label: 'Check stack status', status: 'pending' },
];

const LABEL_SYNTH = 'Synthesize CloudFormation';
const LABEL_STACK_STATUS = 'Check stack status';
const LABEL_API_KEY = 'Set up API key providers';
const LABEL_OAUTH = 'Set up OAuth providers';

const IDENTITY_STEP: Step = { label: LABEL_API_KEY, status: 'pending' };
const BOOTSTRAP_STEP: Step = { label: 'Bootstrap AWS environment', status: 'pending' };

export function useCdkPreflight(options: PreflightOptions): PreflightResult {
  const { logger, isInteractive = false, skipIdentityCheck = false } = options;

  // Create switchable ioHost - starts silent, can be flipped to verbose for deploy
  const switchableIoHost = useMemo(() => createSwitchableIoHost(), []);

  const [phase, setPhase] = useState<PreflightPhase>('idle');
  const [steps, setSteps] = useState<Step[]>(BASE_PREFLIGHT_STEPS);
  const [context, setContext] = useState<PreflightContext | null>(null);
  const [cdkToolkitWrapper, setCdkToolkitWrapper] = useState<CdkToolkitWrapper | null>(null);
  const [stackNames, setStackNames] = useState<string[]>([]);
  const [bootstrapContext, setBootstrapContext] = useState<BootstrapContext | null>(null);
  const [hasTokenExpiredError, setHasTokenExpiredError] = useState(false);
  const [hasCredentialsError, setHasCredentialsError] = useState(false);
  const [missingCredentials, setMissingCredentials] = useState<MissingCredential[]>([]);
  const [runtimeCredentials, setRuntimeCredentials] = useState<SecureCredentials | null>(null);
  const [skipIdentitySetup, setSkipIdentitySetup] = useState(false);
  const [identityKmsKeyArn, setIdentityKmsKeyArn] = useState<string | undefined>(undefined);
  const [allCredentials, setAllCredentials] = useState<
    Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>
  >({});
  const [teardownConfirmed, setTeardownConfirmed] = useState(false);

  // Guard against concurrent runs (React StrictMode, re-renders, etc.)
  const isRunningRef = useRef(false);
  // Keep a ref to the wrapper so we can dispose it when starting a new run
  const wrapperRef = useRef<CdkToolkitWrapper | null>(null);
  // Restore function for AWS_REGION / AWS_DEFAULT_REGION overrides, applied
  // after target resolution so downstream SDK / CDK toolkit-lib clients use the
  // aws-targets.json region rather than whatever the SDK default chain resolves.
  // See https://github.com/aws/agentcore-cli/issues/924.
  const restoreRegionEnvRef = useRef<(() => void) | null>(null);

  const updateStep = (index: number, update: Partial<Step>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...update } : s)));
  };

  const updateStepByLabel = (label: string, update: Partial<Step>) => {
    setSteps(prev => prev.map(s => (s.label === label ? { ...s, ...update } : s)));
  };

  const resetSteps = () => {
    setSteps(BASE_PREFLIGHT_STEPS.map(s => ({ ...s, status: 'pending' as const })));
  };

  // Dispose wrapper and clear ref
  const disposeWrapper = useCallback(async () => {
    if (wrapperRef.current) {
      await wrapperRef.current.dispose();
      wrapperRef.current = null;
    }
  }, []);

  // Restore AWS_REGION / AWS_DEFAULT_REGION (no-op when nothing was applied)
  const restoreRegionEnv = useCallback(() => {
    restoreRegionEnvRef.current?.();
    restoreRegionEnvRef.current = null;
  }, []);

  const startPreflight = useCallback(async () => {
    if (isRunningRef.current) return;
    // Dispose any existing wrapper before starting a new run
    await disposeWrapper();
    // Restore any previously-applied region env override before re-running
    restoreRegionEnv();
    resetSteps();
    setCdkToolkitWrapper(null);
    setStackNames([]);
    setBootstrapContext(null);
    setHasTokenExpiredError(false); // Reset token expired state when retrying
    setHasCredentialsError(false); // Reset credentials error state when retrying
    setPhase('running');
  }, [disposeWrapper, restoreRegionEnv]);

  const clearTokenExpiredError = useCallback(() => {
    setHasTokenExpiredError(false);
  }, []);

  const clearCredentialsError = useCallback(() => {
    setHasCredentialsError(false);
  }, []);

  // Cleanup on unmount or interruption
  useEffect(() => {
    const handleInterrupt = () => {
      void disposeWrapper();
      restoreRegionEnv();
    };

    process.on('SIGINT', handleInterrupt);
    process.on('SIGTERM', handleInterrupt);

    return () => {
      process.off('SIGINT', handleInterrupt);
      process.off('SIGTERM', handleInterrupt);
      // Dispose on unmount (user navigated away)
      void disposeWrapper();
      restoreRegionEnv();
    };
  }, [disposeWrapper, restoreRegionEnv]);

  // Restore region env override when any preflight stage lands in 'error'.
  // Individual error branches inside the stage effects only call setPhase('error')
  // without cleanup, so this hook is the single place that guarantees restore
  // happens on every error path without threading the call into every branch.
  useEffect(() => {
    if (phase === 'error') {
      restoreRegionEnv();
    }
  }, [phase, restoreRegionEnv]);

  const confirmTeardown = useCallback(() => {
    // Mark teardown as confirmed and restart the preflight flow
    setTeardownConfirmed(true);
    setPhase('running');
    isRunningRef.current = false; // Allow the run to restart
  }, []);

  const cancelTeardown = useCallback(() => {
    setPhase('error');
    isRunningRef.current = false;
    restoreRegionEnv();
  }, [restoreRegionEnv]);

  const confirmBootstrap = useCallback(() => {
    setPhase('bootstrapping');
  }, []);

  const skipBootstrap = useCallback(() => {
    setPhase('complete');
    isRunningRef.current = false;
  }, []);

  // Credential prompt callbacks
  const useEnvLocalCredentials = useCallback(() => {
    // Use credentials from .env.local (no runtime override needed)
    setRuntimeCredentials(null);
    setPhase('identity-setup');
  }, []);

  const useManualCredentials = useCallback((credentials: Record<string, string>) => {
    // Use manually entered credentials (runtime override) - wrap in SecureCredentials for safe handling
    setRuntimeCredentials(new SecureCredentials(credentials));
    setPhase('identity-setup');
  }, []);

  const skipCredentials = useCallback(() => {
    // Skip identity setup entirely
    setSkipIdentitySetup(true);
    setPhase('identity-setup');
  }, []);

  // Main preflight effect
  useEffect(() => {
    if (phase !== 'running') return;
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    const handleUnhandledRejection = (reason: unknown) => {
      const error = formatError(reason);
      setSteps(prev => {
        const runningIndex = prev.findIndex(s => s.status === 'running');
        if (runningIndex >= 0) {
          return prev.map((s, i) =>
            i === runningIndex ? { ...s, status: 'error' as const, error: `Unhandled error: ${error}` } : s
          );
        }
        const pendingIndex = prev.findIndex(s => s.status === 'pending');
        if (pendingIndex >= 0) {
          return prev.map((s, i) =>
            i === pendingIndex ? { ...s, status: 'error' as const, error: `Unhandled error: ${error}` } : s
          );
        }
        return prev;
      });
      setPhase('error');
      isRunningRef.current = false;
    };

    process.on('unhandledRejection', handleUnhandledRejection);

    const run = async () => {
      try {
        // Step: Validate project
        updateStep(STEP_VALIDATE, { status: 'running' });
        logger.startStep('Validate project');
        let preflightContext: PreflightContext;
        try {
          preflightContext = await validateProject();
          setContext(preflightContext);
          // Make aws-targets.json region authoritative for downstream SDK / CDK
          // toolkit-lib clients that bypass explicit region options. Restored on
          // unmount, teardown rejection, or subsequent preflight start.
          // See https://github.com/aws/agentcore-cli/issues/924.
          const firstTarget = preflightContext.awsTargets[0];
          if (firstTarget) {
            restoreRegionEnv();
            restoreRegionEnvRef.current = applyTargetRegionToEnv(firstTarget.region);
          }
          logger.endStep('success');
          updateStep(STEP_VALIDATE, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          // Check if this is a credentials error (no AWS credentials configured)
          if (isNoCredentialsError(err)) {
            setHasCredentialsError(true);
          }
          // In interactive mode with credentials error, use short message (UI handles recovery)
          // In non-interactive mode, show full message with fix instructions
          let userMessage: string;
          if (isInteractive && err instanceof AwsCredentialsError) {
            userMessage = err.shortMessage;
          } else {
            userMessage = getErrorMessage(err);
          }
          updateStep(STEP_VALIDATE, { status: 'error', error: userMessage });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Teardown confirmation: pause for user confirmation before proceeding
        if (preflightContext.isTeardownDeploy && !teardownConfirmed) {
          setPhase('teardown-confirm');
          isRunningRef.current = false;
          return;
        }

        // Validate AWS credentials (deferred for teardown deploys until after confirmation)
        if (preflightContext.isTeardownDeploy) {
          try {
            await validateAwsCredentials();
          } catch (err) {
            const errorMsg = formatError(err);
            logger.endStep('error', errorMsg);
            if (isNoCredentialsError(err)) {
              setHasCredentialsError(true);
            }
            const userMessage =
              isInteractive && err instanceof AwsCredentialsError ? err.shortMessage : getErrorMessage(err);
            updateStep(STEP_VALIDATE, { status: 'error', error: userMessage });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }
        }

        // Step: Check dependencies (Node >= 18, uv for Python CodeZip)
        updateStep(STEP_DEPS, { status: 'running' });
        logger.startStep('Check dependencies');
        try {
          const depsResult = await checkDependencyVersions(preflightContext.projectSpec);
          if (!depsResult.passed) {
            const errorMsg = depsResult.errors.join('\n');
            logger.endStep('error', errorMsg);
            updateStep(STEP_DEPS, { status: 'error', error: errorMsg });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }
          // Log version info
          if (depsResult.nodeCheck.current) {
            logger.log(`Node.js: ${depsResult.nodeCheck.current}`);
          }
          if (depsResult.uvCheck?.current) {
            logger.log(`uv: ${depsResult.uvCheck.current}`);
          }
          logger.endStep('success');
          updateStep(STEP_DEPS, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          updateStep(STEP_DEPS, { status: 'error', error: logger.getFailureMessage('Check dependencies') });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Step: Build CDK project
        updateStep(STEP_BUILD, { status: 'running' });
        logger.startStep('Build CDK project');
        try {
          await buildCdkProject(preflightContext.cdkProject);
          logger.endStep('success');
          updateStep(STEP_BUILD, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          updateStep(STEP_BUILD, { status: 'error', error: logger.getFailureMessage('Build CDK project') });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Check if API key providers need setup before CDK synth (CDK needs credential ARNs)
        // Skip this check if skipIdentityCheck is true (e.g., plan command only synthesizes)
        const needsCredentialSetup =
          !skipIdentityCheck &&
          (hasIdentityApiProviders(preflightContext.projectSpec) ||
            hasIdentityOAuthProviders(preflightContext.projectSpec));
        if (needsCredentialSetup) {
          // Get all credentials for the prompt (not just missing ones)
          const allCredentials = getAllCredentials(preflightContext.projectSpec);

          // Always show dialog when credentials exist
          setMissingCredentials(allCredentials);
          setPhase('credentials-prompt');
          isRunningRef.current = false; // Reset so identity-setup can run after user input
          return;
        }

        // Step: Synthesize CloudFormation
        updateStepByLabel(LABEL_SYNTH, { status: 'running' });
        logger.startStep('Synthesize CloudFormation');
        let synthStackNames: string[];
        try {
          const synthResult = await synthesizeCdk(preflightContext.cdkProject, {
            ioHost: switchableIoHost.ioHost,
            previousWrapper: wrapperRef.current,
          });
          wrapperRef.current = synthResult.toolkitWrapper;
          setCdkToolkitWrapper(synthResult.toolkitWrapper);
          setStackNames(synthResult.stackNames);
          synthStackNames = synthResult.stackNames;
          logger.log(`Stacks: ${synthResult.stackNames.join(', ')}`);
          logger.endStep('success');
          updateStepByLabel(LABEL_SYNTH, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          if (isExpiredTokenError(err)) {
            setHasTokenExpiredError(true);
          }
          updateStepByLabel(LABEL_SYNTH, {
            status: 'error',
            error: logger.getFailureMessage('Synthesize CloudFormation'),
          });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Step: Check stack status (ensure stacks are not in UPDATE_IN_PROGRESS etc.)
        const target = preflightContext.awsTargets[0];
        if (target && synthStackNames.length > 0) {
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'running' });
          logger.startStep('Check stack status');
          try {
            const stackStatus = await checkStackDeployability(target.region, synthStackNames);
            if (!stackStatus.canDeploy) {
              const errorMsg = stackStatus.message ?? `Stack ${stackStatus.blockingStack} is not in a deployable state`;
              logger.endStep('error', errorMsg);
              updateStepByLabel(LABEL_STACK_STATUS, { status: 'error', error: errorMsg });
              setPhase('error');
              isRunningRef.current = false;
              return;
            }
            logger.endStep('success');
            updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
          } catch (err) {
            const errorMsg = formatError(err);
            logger.endStep('error', errorMsg);
            if (isExpiredTokenError(err)) {
              setHasTokenExpiredError(true);
            }
            updateStepByLabel(LABEL_STACK_STATUS, {
              status: 'error',
              error: logger.getFailureMessage('Check stack status'),
            });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }
        } else {
          // Skip stack status check if no target or no stacks
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
        }

        // Check if bootstrap is needed
        const bootstrapCheck = await checkBootstrapNeeded(preflightContext.awsTargets);
        if (bootstrapCheck.needsBootstrap && bootstrapCheck.target) {
          setBootstrapContext({
            toolkitWrapper: wrapperRef.current,
            target: bootstrapCheck.target,
          });
          setPhase('bootstrap-confirm');
          return;
        }

        setPhase('complete');
        isRunningRef.current = false;
      } catch (err) {
        const errorMsg = formatError(err);
        logger.endStep('error', errorMsg);
        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }
        setSteps(prev => {
          const runningIndex = prev.findIndex(s => s.status === 'running');
          if (runningIndex >= 0) {
            const stepName = prev[runningIndex]?.label ?? 'Unknown step';
            return prev.map((s, i) =>
              i === runningIndex ? { ...s, status: 'error' as const, error: logger.getFailureMessage(stepName) } : s
            );
          }
          return prev;
        });
        setPhase('error');
        isRunningRef.current = false;
      }
    };

    void run();

    return () => {
      process.off('unhandledRejection', handleUnhandledRejection);
    };
  }, [phase, logger, switchableIoHost, isInteractive, skipIdentityCheck, teardownConfirmed, restoreRegionEnv]);

  // Handle identity-setup phase (after user provides credentials)
  useEffect(() => {
    if (phase !== 'identity-setup' || !context) return;
    if (isRunningRef.current) return; // Prevent duplicate runs
    isRunningRef.current = true;

    const runIdentitySetup = async () => {
      // If user chose to skip, go directly to synth
      if (skipIdentitySetup) {
        logger.log('Skipping identity provider setup (user choice)');
        setSkipIdentitySetup(false); // Reset for next run

        // Synthesize CloudFormation
        updateStepByLabel(LABEL_SYNTH, { status: 'running' });
        logger.startStep('Synthesize CloudFormation');
        let synthStackNames: string[];
        try {
          const synthResult = await synthesizeCdk(context.cdkProject, {
            ioHost: switchableIoHost.ioHost,
            previousWrapper: wrapperRef.current,
          });
          wrapperRef.current = synthResult.toolkitWrapper;
          setCdkToolkitWrapper(synthResult.toolkitWrapper);
          setStackNames(synthResult.stackNames);
          synthStackNames = synthResult.stackNames;
          logger.endStep('success');
          updateStepByLabel(LABEL_SYNTH, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          updateStepByLabel(LABEL_SYNTH, {
            status: 'error',
            error: logger.getFailureMessage('Synthesize CloudFormation'),
          });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Check stack status
        const target = context.awsTargets[0];
        if (target && synthStackNames.length > 0) {
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'running' });
          logger.startStep('Check stack status');
          try {
            const stackStatus = await checkStackDeployability(target.region, synthStackNames);
            if (!stackStatus.canDeploy) {
              const errorMsg = stackStatus.message ?? `Stack ${stackStatus.blockingStack} is not in a deployable state`;
              logger.endStep('error', errorMsg);
              updateStepByLabel(LABEL_STACK_STATUS, { status: 'error', error: errorMsg });
              setPhase('error');
              isRunningRef.current = false;
              return;
            }
            logger.endStep('success');
            updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
          } catch (err) {
            const errorMsg = formatError(err);
            logger.endStep('error', errorMsg);
            if (isExpiredTokenError(err)) {
              setHasTokenExpiredError(true);
            }
            updateStepByLabel(LABEL_STACK_STATUS, {
              status: 'error',
              error: logger.getFailureMessage('Check stack status'),
            });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }
        } else {
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
        }

        // Check if bootstrap is needed
        const bootstrapCheck = await checkBootstrapNeeded(context.awsTargets);
        if (bootstrapCheck.needsBootstrap && bootstrapCheck.target) {
          setBootstrapContext({
            toolkitWrapper: wrapperRef.current,
            target: bootstrapCheck.target,
          });
          setPhase('bootstrap-confirm');
          return;
        }

        setPhase('complete');
        isRunningRef.current = false;
        return;
      }

      // Run identity setup with runtime credentials
      // Insert identity steps before synthesize in the step list
      const hasApiKeys = hasIdentityApiProviders(context.projectSpec);
      const hasOAuth = hasIdentityOAuthProviders(context.projectSpec);
      setSteps(prev => {
        const synthIndex = prev.findIndex(s => s.label === LABEL_SYNTH);
        const identitySteps: Step[] = [];
        if (hasApiKeys) identitySteps.push({ ...IDENTITY_STEP, status: 'running' });
        if (hasOAuth) identitySteps.push({ label: LABEL_OAUTH, status: hasApiKeys ? 'pending' : 'running' });
        return [...prev.slice(0, synthIndex), ...identitySteps, ...prev.slice(synthIndex)];
      });

      if (hasApiKeys) {
        logger.startStep('Set up API key providers');
      }

      const target = context.awsTargets[0];
      if (!target) {
        const errorMsg = 'No AWS target configured';
        if (hasApiKeys) {
          logger.endStep('error', errorMsg);
          updateStepByLabel(LABEL_API_KEY, { status: 'error', error: errorMsg });
        } else if (hasOAuth) {
          updateStepByLabel(LABEL_OAUTH, { status: 'error', error: errorMsg });
        }
        setPhase('error');
        isRunningRef.current = false;
        return;
      }

      try {
        const configBaseDir = path.dirname(context.cdkProject.projectDir);

        // Collect credential ARNs for deployed state
        const deployedCredentials: Record<
          string,
          { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }
        > = {};
        let kmsKeyArn: string | undefined;

        // Set up API key providers if needed
        if (hasApiKeys) {
          const identityResult = await setupApiKeyProviders({
            projectSpec: context.projectSpec,
            configBaseDir,
            region: target.region,
            runtimeCredentials: runtimeCredentials ?? undefined,
            enableKmsEncryption: true,
          });

          // Log KMS setup
          if (identityResult.kmsKeyArn) {
            logger.log(`Token vault encrypted with KMS key: ${identityResult.kmsKeyArn}`);
            kmsKeyArn = identityResult.kmsKeyArn;
            setIdentityKmsKeyArn(identityResult.kmsKeyArn);
          }

          // Log results
          for (const result of identityResult.results) {
            if (result.status === 'created') {
              logger.log(`Created API key provider: ${result.providerName}`);
            } else if (result.status === 'updated') {
              logger.log(`Updated API key provider: ${result.providerName}`);
            } else if (result.status === 'exists') {
              logger.log(`API key provider exists: ${result.providerName}`);
            } else if (result.status === 'skipped') {
              logger.log(`Skipped ${result.providerName}: ${result.error}`);
            } else if (result.status === 'error') {
              logger.log(`Error for ${result.providerName}: ${result.error}`);
            }
          }

          if (identityResult.hasErrors) {
            logger.endStep('error', 'Some API key providers failed to set up');
            updateStepByLabel(LABEL_API_KEY, { status: 'error', error: 'Some API key providers failed' });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }

          logger.endStep('success');
          updateStepByLabel(LABEL_API_KEY, { status: 'success' });

          for (const result of identityResult.results) {
            if (result.credentialProviderArn) {
              deployedCredentials[result.providerName] = {
                credentialProviderArn: result.credentialProviderArn,
              };
            }
          }
        }

        // Set up OAuth credential providers if needed
        if (hasOAuth) {
          updateStepByLabel(LABEL_OAUTH, { status: 'running' });
          logger.startStep('Set up OAuth providers');

          const oauthResult = await setupOAuth2Providers({
            projectSpec: context.projectSpec,
            configBaseDir,
            region: target.region,
            runtimeCredentials: runtimeCredentials ?? undefined,
          });

          for (const result of oauthResult.results) {
            if (result.status === 'created') {
              logger.log(`Created OAuth provider: ${result.providerName}`);
            } else if (result.status === 'updated') {
              logger.log(`Updated OAuth provider: ${result.providerName}`);
            } else if (result.status === 'skipped') {
              logger.log(`Skipped ${result.providerName}: ${result.error}`);
            } else if (result.status === 'error') {
              logger.log(`Error for ${result.providerName}: ${result.error}`);
            }
          }

          if (oauthResult.hasErrors) {
            logger.endStep('error', 'Some OAuth providers failed to set up');
            updateStepByLabel(LABEL_OAUTH, { status: 'error', error: 'Some OAuth providers failed' });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }

          // Collect credential ARNs for deployed state
          const creds: Record<
            string,
            { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }
          > = {};
          for (const result of oauthResult.results) {
            if (result.credentialProviderArn) {
              creds[result.providerName] = {
                credentialProviderArn: result.credentialProviderArn,
                clientSecretArn: result.clientSecretArn,
                callbackUrl: result.callbackUrl,
              };
            }
          }
          Object.assign(deployedCredentials, creds);

          logger.endStep('success');
          updateStepByLabel(LABEL_OAUTH, { status: 'success' });
        }

        // Write partial deployed state with credential ARNs before CDK synth
        if (Object.keys(deployedCredentials).length > 0) {
          setAllCredentials(deployedCredentials);
          const configIO = new ConfigIO();
          const target = context.awsTargets[0];
          const existingState = await configIO.readDeployedState().catch(() => ({ targets: {} }) as DeployedState);
          const targetState = existingState.targets?.[target!.name] ?? { resources: {} };
          targetState.resources ??= {};
          targetState.resources.credentials = deployedCredentials;
          if (kmsKeyArn) targetState.resources.identityKmsKeyArn = kmsKeyArn;
          await configIO.writeDeployedState({
            ...existingState,
            targets: { ...existingState.targets, [target!.name]: targetState },
          });
        }

        // Clear runtime credentials
        setRuntimeCredentials(null);

        // Synthesize CloudFormation now that credentials are in deployed state
        updateStepByLabel(LABEL_SYNTH, { status: 'running' });
        logger.startStep('Synthesize CloudFormation');
        let synthStackNames: string[];
        try {
          const synthResult = await synthesizeCdk(context.cdkProject, {
            ioHost: switchableIoHost.ioHost,
            previousWrapper: wrapperRef.current,
          });
          wrapperRef.current = synthResult.toolkitWrapper;
          setCdkToolkitWrapper(synthResult.toolkitWrapper);
          setStackNames(synthResult.stackNames);
          synthStackNames = synthResult.stackNames;
          logger.endStep('success');
          updateStepByLabel(LABEL_SYNTH, { status: 'success' });
        } catch (err) {
          const errorMsg = formatError(err);
          logger.endStep('error', errorMsg);
          updateStepByLabel(LABEL_SYNTH, {
            status: 'error',
            error: logger.getFailureMessage('Synthesize CloudFormation'),
          });
          setPhase('error');
          isRunningRef.current = false;
          return;
        }

        // Check stack status
        if (target && synthStackNames.length > 0) {
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'running' });
          logger.startStep('Check stack status');
          try {
            const stackStatus = await checkStackDeployability(target.region, synthStackNames);
            if (!stackStatus.canDeploy) {
              const errorMsg = stackStatus.message ?? `Stack ${stackStatus.blockingStack} is not in a deployable state`;
              logger.endStep('error', errorMsg);
              updateStepByLabel(LABEL_STACK_STATUS, { status: 'error', error: errorMsg });
              setPhase('error');
              isRunningRef.current = false;
              return;
            }
            logger.endStep('success');
            updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
          } catch (err) {
            const errorMsg = formatError(err);
            logger.endStep('error', errorMsg);
            if (isExpiredTokenError(err)) {
              setHasTokenExpiredError(true);
            }
            updateStepByLabel(LABEL_STACK_STATUS, {
              status: 'error',
              error: logger.getFailureMessage('Check stack status'),
            });
            setPhase('error');
            isRunningRef.current = false;
            return;
          }
        } else {
          updateStepByLabel(LABEL_STACK_STATUS, { status: 'success' });
        }

        // Check if bootstrap is needed
        const bootstrapCheck = await checkBootstrapNeeded(context.awsTargets);
        if (bootstrapCheck.needsBootstrap && bootstrapCheck.target) {
          setBootstrapContext({
            toolkitWrapper: wrapperRef.current,
            target: bootstrapCheck.target,
          });
          setPhase('bootstrap-confirm');
          return;
        }

        setPhase('complete');
        isRunningRef.current = false;
      } catch (err) {
        const errorMsg = formatError(err);
        logger.endStep('error', errorMsg);
        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }
        setSteps(prev =>
          prev.map((s, i) =>
            i === prev.length - 1
              ? { ...s, status: 'error', error: logger.getFailureMessage('Set up API key providers') }
              : s
          )
        );
        setPhase('error');
        isRunningRef.current = false;
      }
    };

    void runIdentitySetup();
  }, [phase, context, skipIdentitySetup, runtimeCredentials, logger, switchableIoHost.ioHost]);

  // Handle bootstrapping phase
  useEffect(() => {
    if (phase !== 'bootstrapping' || !bootstrapContext) return;

    const runBootstrap = async () => {
      setSteps(prev => [...prev, { ...BOOTSTRAP_STEP, status: 'running' }]);
      logger.startStep('Bootstrap AWS environment');

      try {
        await bootstrapEnvironment(bootstrapContext.toolkitWrapper, bootstrapContext.target);
        logger.endStep('success');
        // Update the last step (bootstrap step we just added)
        setSteps(prev => prev.map((s, i) => (i === prev.length - 1 ? { ...s, status: 'success' } : s)));
        setPhase('complete');
        isRunningRef.current = false;
      } catch (err) {
        const errorMsg = formatError(err);
        logger.endStep('error', errorMsg);
        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }
        setSteps(prev =>
          prev.map((s, i) =>
            i === prev.length - 1
              ? { ...s, status: 'error', error: logger.getFailureMessage('Bootstrap AWS environment') }
              : s
          )
        );
        setPhase('error');
        isRunningRef.current = false;
      }
    };

    void runBootstrap();
  }, [phase, bootstrapContext, logger]);

  return {
    phase,
    steps,
    context,
    cdkToolkitWrapper,
    stackNames,
    switchableIoHost,
    hasTokenExpiredError,
    hasCredentialsError,
    missingCredentials,
    identityKmsKeyArn,
    allCredentials,
    startPreflight,
    confirmTeardown,
    cancelTeardown,
    confirmBootstrap,
    skipBootstrap,
    clearTokenExpiredError,
    clearCredentialsError,
    useEnvLocalCredentials,
    useManualCredentials,
    skipCredentials,
  };
}
