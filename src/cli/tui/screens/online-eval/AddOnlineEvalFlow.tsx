import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import { ErrorPrompt } from '../../components';
import { useCreateOnlineEval, useExistingOnlineEvalNames } from '../../hooks/useCreateOnlineEval';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddOnlineEvalScreen } from './AddOnlineEvalScreen';
import type { AddOnlineEvalConfig, EvaluatorItem } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; evaluators: EvaluatorItem[]; agentNames: string[] }
  | { name: 'create-success'; configName: string }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string };

interface AddOnlineEvalFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddOnlineEvalFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddOnlineEvalFlowProps) {
  const { createOnlineEval, reset: resetCreate } = useCreateOnlineEval();
  const { names: existingConfigNames } = useExistingOnlineEvalNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // Pre-check AWS credentials then fetch evaluators from the account
  useEffect(() => {
    if (flow.name !== 'loading') return;
    let cancelled = false;

    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setFlow({ name: 'creds-error', message: getErrorMessage(err) });
        return;
      }

      try {
        const [{ region }, projectSpec] = await Promise.all([detectRegion(), new ConfigIO().readProjectSpec()]);
        const result = await listEvaluators({ region });
        if (cancelled) return;

        const items: EvaluatorItem[] = result.evaluators.map(e => ({
          arn: e.evaluatorArn,
          name: e.evaluatorName,
          type: e.evaluatorType,
          description: e.description,
        }));

        const agentNames = projectSpec.agents.map(a => a.name);

        if (agentNames.length === 0) {
          setFlow({
            name: 'error',
            message: 'No agents found in project. Add an agent first with `agentcore add agent`.',
          });
          return;
        }

        setFlow({ name: 'create-wizard', evaluators: items, agentNames });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddOnlineEvalConfig) => {
      void createOnlineEval(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', configName: result.configName });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createOnlineEval]
  );

  if (flow.name === 'loading') {
    return null;
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onBack} onExit={onExit} />;
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddOnlineEvalScreen
        existingConfigNames={existingConfigNames}
        evaluatorItems={flow.evaluators}
        agentNames={flow.agentNames}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added online eval config: ${flow.configName}`}
        detail="Online eval config added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy`."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add online eval config"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'loading' });
      }}
      onExit={onExit}
    />
  );
}
