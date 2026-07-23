import { ConfigIO } from '../../../lib';
import type { DeployMessage } from '../../cdk/toolkit-lib';
import { handleDeploy } from '../../commands/deploy/actions';
import { getErrorMessage } from '../../errors';
import { MANAGED_MEMORY_DEPLOY_NOTICE, ensureDefaultDeploymentTarget } from '../../operations/deploy';
import { canSkipDeploy } from '../../operations/deploy/change-detection';
import type { Step } from '../components/StepProgress';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseDevDeployOptions {
  skip?: boolean;
  ready?: boolean;
}

export interface UseDevDeployResult {
  steps: Step[];
  deployMessages: DeployMessage[];
  isComplete: boolean;
  error: string | undefined;
  logPath: string | undefined;
  /** Managed-memory heads-up surfaced by handleDeploy (null when not applicable) */
  managedMemoryNotice: string | null;
  /** Managed dependency sync summary from the deploy result (null when nothing changed) */
  dependencySyncNotice: string | null;
  /** Managed dependency sync warnings from the deploy result */
  dependencySyncWarnings: string[];
}

export function useDevDeploy({ skip, ready = true }: UseDevDeployOptions = {}): UseDevDeployResult {
  const [steps, setSteps] = useState<Step[]>([]);
  const [deployMessages, setDeployMessages] = useState<DeployMessage[]>([]);
  const [deployDone, setDeployDone] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [logPath, setLogPath] = useState<string | undefined>();
  const [managedMemoryNotice, setManagedMemoryNotice] = useState<string | null>(null);
  // Dep-sync gets its own slot: it's a multi-line summary read from the deploy RESULT, not the
  // generic onNotice stream — multiplexing it through onNotice would let the managed-memory
  // heads-up clobber it in the single "Note:" line.
  const [dependencySyncNotice, setDependencySyncNotice] = useState<string | null>(null);
  const [dependencySyncWarnings, setDependencySyncWarnings] = useState<string[]>([]);
  const hasStarted = useRef(false);

  const onProgress = useCallback((stepName: string, status: 'start' | 'success' | 'error' | 'warn') => {
    setSteps(prev => {
      if (status === 'start') {
        return [...prev, { label: stepName, status: 'running' }];
      }
      return prev.map(s => (s.label === stepName ? { ...s, status: status } : s));
    });
  }, []);

  const onDeployMessage = useCallback((msg: DeployMessage) => {
    setDeployMessages(prev => [...prev, msg]);
  }, []);

  // onNotice is a generic stream (handleDeploy also emits the dep-sync notice through it);
  // only the managed-memory heads-up belongs in the single "Note:" line — the dep-sync
  // summary is read from the deploy result instead, so the two can't clobber each other.
  const onNotice = useCallback((message: string) => {
    if (message === MANAGED_MEMORY_DEPLOY_NOTICE) {
      setManagedMemoryNotice(message);
    }
  }, []);

  useEffect(() => {
    if (skip || !ready || hasStarted.current) return;
    hasStarted.current = true;

    const run = async () => {
      try {
        const configIO = new ConfigIO();

        // Only deploy if the project has harnesses (cloud-dependent resources).
        // Plain agents (Strands, LangGraph, etc.) run locally and don't need deployment.
        try {
          const projectSpec = await configIO.readProjectSpec();
          const hasHarnesses = (projectSpec.harnesses ?? []).length > 0;
          if (!hasHarnesses) {
            onProgress('Local agent — no deploy needed', 'success');
            return;
          }
        } catch {
          // If we can't read project spec, proceed with deploy as a safe default
        }

        // Auto-populate aws-targets.json if empty (best-effort). handleDeploy also
        // does this, but we run it here first so canSkipDeploy sees a populated target.
        await ensureDefaultDeploymentTarget(configIO);

        const noChanges = await canSkipDeploy(configIO);
        if (noChanges) {
          onProgress('No changes detected — skipping deploy', 'success');
          return;
        }

        const result = await handleDeploy({
          target: 'default',
          autoConfirm: true,
          verbose: true,
          onProgress,
          onDeployMessage,
          onNotice,
        });

        if (result.logPath) {
          setLogPath(result.logPath);
        }

        if (result.dependencySyncResult) {
          setDependencySyncNotice(result.dependencySyncResult.notice);
          setDependencySyncWarnings(result.dependencySyncResult.warnings);
        }

        if (!result.success) {
          setError(getErrorMessage(result.error));
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setDeployDone(true);
      }
    };

    void run();
  }, [skip, ready, onProgress, onDeployMessage, onNotice]);

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- skip is boolean, not nullable; || is the correct operator here
  const isComplete = skip || deployDone;

  return {
    steps,
    deployMessages,
    isComplete,
    error,
    logPath,
    managedMemoryNotice,
    dependencySyncNotice,
    dependencySyncWarnings,
  };
}
