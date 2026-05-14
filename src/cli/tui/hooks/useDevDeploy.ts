import { ConfigIO } from '../../../lib';
import { detectAwsContext } from '../../aws/aws-context';
import type { DeployMessage } from '../../cdk/toolkit-lib';
import { handleDeploy } from '../../commands/deploy/actions';
import { getErrorMessage } from '../../errors';
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
}

export function useDevDeploy({ skip, ready = true }: UseDevDeployOptions = {}): UseDevDeployResult {
  const [steps, setSteps] = useState<Step[]>([]);
  const [deployMessages, setDeployMessages] = useState<DeployMessage[]>([]);
  const [deployDone, setDeployDone] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [logPath, setLogPath] = useState<string | undefined>();
  const hasStarted = useRef(false);

  const onProgress = useCallback((stepName: string, status: 'start' | 'success' | 'error') => {
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

  useEffect(() => {
    if (skip || !ready || hasStarted.current) return;
    hasStarted.current = true;

    const run = async () => {
      try {
        const configIO = new ConfigIO();

        // Auto-populate aws-targets.json if empty
        try {
          const targets = await configIO.readAWSDeploymentTargets();
          if (targets.length === 0) {
            const ctx = await detectAwsContext();
            if (ctx.accountId) {
              await configIO.writeAWSDeploymentTargets([
                { name: 'default', account: ctx.accountId, region: ctx.region },
              ]);
            }
          }
        } catch {
          try {
            const ctx = await detectAwsContext();
            if (ctx.accountId) {
              await configIO.writeAWSDeploymentTargets([
                { name: 'default', account: ctx.accountId, region: ctx.region },
              ]);
            }
          } catch {
            // Can't detect — let handleDeploy fail with a clear error
          }
        }

        const noChanges = await canSkipDeploy(configIO);
        if (noChanges) {
          onProgress('No changes detected — skipping deploy', 'success');
          return;
        }

        const result = await handleDeploy({
          target: 'default',
          autoConfirm: true,
          onProgress,
          onDeployMessage,
        });

        if (result.logPath) {
          setLogPath(result.logPath);
        }

        if (!result.success) {
          setError(result.error);
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setDeployDone(true);
      }
    };

    void run();
  }, [skip, ready, onProgress, onDeployMessage]);

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- skip is boolean, not nullable; || is the correct operator here
  const isComplete = skip || deployDone;

  return { steps, deployMessages, isComplete, error, logPath };
}
