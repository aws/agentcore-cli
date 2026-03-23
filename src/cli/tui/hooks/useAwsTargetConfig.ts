import { ConfigIO, NoProjectError, findConfigRoot } from '../../../lib';
import type { AgentCoreRegion, AwsDeploymentTarget } from '../../../schema';
import { detectAwsContext } from '../../aws';
import { getErrorMessage } from '../../errors';
import { useCallback, useEffect, useState } from 'react';

export type AwsConfigPhase =
  | 'checking'
  | 'configured'
  | 'detecting'
  | 'choice'
  | 'select-target'
  | 'manual-account'
  | 'manual-region'
  | 'saving'
  | 'token-expired'
  | 'error';

export interface AwsTargetConfigState {
  phase: AwsConfigPhase;
  /** True when targets are configured and ready to proceed */
  isConfigured: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Detected region (used as default for manual entry) */
  detectedRegion: AgentCoreRegion;
  /** Available targets for selection (when phase === 'select-target') */
  availableTargets: AwsDeploymentTarget[];
  /** Selected target indices (empty means all targets) */
  selectedTargetIndices: number[];
  /** Pending target indices for multi-select (before confirmation) */
  pendingTargetIndices: number[];
  /** Start the configuration flow (if not already configured) */
  startConfig: () => void;
  /** User chose to exit and run aws login */
  selectAwsLogin: () => void;
  /** User chose manual entry */
  selectManualEntry: () => void;
  /** Submit manual account ID */
  submitAccountId: (accountId: string) => void;
  /** Submit manual region */
  submitRegion: (region: AgentCoreRegion) => void;
  /** Go back to choice screen */
  goBackToChoice: () => void;
  /** Select all targets immediately and proceed */
  selectAllTargets: () => void;
  /** Toggle a single target in multi-select mode */
  toggleTarget: (index: number) => void;
  /** Confirm the pending multi-select and proceed */
  confirmTargetSelection: () => void;
  /** Trigger the token-expired recovery flow (called when deploy/plan catches an expired token error) */
  triggerTokenExpired: () => void;
  /** Reset from token-expired state back to configured (after successful re-auth) */
  resetFromTokenExpired: () => void;
  /** Trigger the no-credentials recovery flow (called when deploy/plan catches a credentials error) */
  triggerNoCredentials: () => void;
  /** Reset from choice state back to configured (after successful credential setup) */
  resetFromChoice: () => void;
}

/**
 * Hook to manage AWS target configuration.
 * Used by plan and deploy screens to ensure aws-targets.json is configured
 * before proceeding with CDK operations.
 *
 * Flow:
 * 1. Check if aws-targets.json has entries
 * 2. If empty, try to auto-detect AWS context
 * 3. If auto-detect fails (no credentials), show choice:
 *    - Exit and run `aws login` (recommended)
 *    - Manual entry (account ID + region)
 * 4. Save target to aws-targets.json
 */
export function useAwsTargetConfig(): AwsTargetConfigState {
  const [phase, setPhase] = useState<AwsConfigPhase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [detectedRegion, setDetectedRegion] = useState<AgentCoreRegion>('us-east-1');
  const [manualAccountId, setManualAccountId] = useState<string>('');
  const [availableTargets, setAvailableTargets] = useState<AwsDeploymentTarget[]>([]);
  const [selectedTargetIndices, setSelectedTargetIndices] = useState<number[]>([]);
  const [pendingTargetIndices, setPendingTargetIndices] = useState<number[]>([]);

  const saveTarget = useCallback(async (accountId: string, region: AgentCoreRegion) => {
    const configRoot = findConfigRoot();
    if (!configRoot) {
      throw new NoProjectError();
    }

    const configIO = new ConfigIO({ baseDir: configRoot });
    const target: AwsDeploymentTarget = {
      name: 'default',
      description: `Default target (${region})`,
      account: accountId,
      region: region,
    };
    await configIO.writeAWSDeploymentTargets([target]);
  }, []);

  // Check if targets already exist on mount
  useEffect(() => {
    if (phase !== 'checking') return;

    const checkExisting = async () => {
      try {
        const configRoot = findConfigRoot();
        if (!configRoot) {
          setError(new NoProjectError().message);
          setPhase('error');
          return;
        }

        const configIO = new ConfigIO({ baseDir: configRoot });
        const targets = await configIO.resolveAWSDeploymentTargets();

        if (targets.length > 1) {
          // Multiple targets - show selection
          setAvailableTargets(targets);
          setPhase('select-target');
        } else if (targets.length === 1) {
          // Single target - use it directly
          setAvailableTargets(targets);
          setSelectedTargetIndices([0]);
          setPhase('configured');
        } else {
          // Need to configure - start detecting
          setPhase('detecting');
        }
      } catch (err) {
        setError(getErrorMessage(err));
        setPhase('error');
      }
    };

    void checkExisting();
  }, [phase]);

  // Auto-detect AWS context when in detecting phase
  useEffect(() => {
    if (phase !== 'detecting') return;

    const detect = async () => {
      try {
        const awsContext = await detectAwsContext();
        setDetectedRegion(awsContext.region);

        if (awsContext.accountId) {
          // Auto-detected successfully - save and proceed
          await saveTarget(awsContext.accountId, awsContext.region);
          setPhase('configured');
        } else {
          // No credentials detected - show choice
          setPhase('choice');
        }
      } catch {
        // Detection failed - show choice
        setPhase('choice');
      }
    };

    void detect();
  }, [phase, saveTarget]);

  const startConfig = useCallback(() => {
    if (phase === 'configured') return;
    setPhase('detecting');
  }, [phase]);

  const selectAwsLogin = useCallback(() => {
    // This is a signal - the parent component handles exiting to shell
  }, []);

  const selectManualEntry = useCallback(() => {
    setPhase('manual-account');
  }, []);

  const submitAccountId = useCallback((accountId: string) => {
    setManualAccountId(accountId);
    setPhase('manual-region');
  }, []);

  const submitRegion = useCallback(
    (region: AgentCoreRegion) => {
      setPhase('saving');
      async function save() {
        try {
          await saveTarget(manualAccountId, region);
          setPhase('configured');
        } catch (err) {
          setError(getErrorMessage(err));
          setPhase('error');
        }
      }
      void save();
    },
    [manualAccountId, saveTarget]
  );

  const goBackToChoice = useCallback(() => {
    setPhase('choice');
  }, []);

  const selectAllTargets = useCallback(() => {
    // Select all targets immediately and proceed
    setSelectedTargetIndices(availableTargets.map((_, i) => i));
    setPhase('configured');
  }, [availableTargets]);

  const toggleTarget = useCallback((index: number) => {
    setPendingTargetIndices(prev => {
      if (prev.includes(index)) {
        return prev.filter(i => i !== index);
      } else {
        return [...prev, index].sort((a, b) => a - b);
      }
    });
  }, []);

  const confirmTargetSelection = useCallback(() => {
    if (pendingTargetIndices.length === 0) return; // Don't proceed with no selection
    setSelectedTargetIndices(pendingTargetIndices);
    setPhase('configured');
  }, [pendingTargetIndices]);

  const triggerTokenExpired = useCallback(() => {
    setPhase('token-expired');
  }, []);

  const resetFromTokenExpired = useCallback(() => {
    // After re-authentication, go back to configured state
    setPhase('configured');
  }, []);

  const triggerNoCredentials = useCallback(() => {
    // Show the choice UI for credential setup
    setPhase('choice');
  }, []);

  const resetFromChoice = useCallback(() => {
    // After credential setup, go back to configured state
    setPhase('configured');
  }, []);

  return {
    phase,
    isConfigured: phase === 'configured',
    error,
    detectedRegion,
    availableTargets,
    selectedTargetIndices,
    pendingTargetIndices,
    startConfig,
    selectAwsLogin,
    selectManualEntry,
    submitAccountId,
    submitRegion,
    goBackToChoice,
    selectAllTargets,
    toggleTarget,
    confirmTargetSelection,
    triggerTokenExpired,
    resetFromTokenExpired,
    triggerNoCredentials,
    resetFromChoice,
  };
}
