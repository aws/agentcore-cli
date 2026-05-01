import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import { ErrorPrompt, GradientText } from '../../components';
import { useCreateOnlineEval, useExistingOnlineEvalNames } from '../../hooks/useCreateOnlineEval';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import type { RuntimeInfoForEval } from './AddOnlineEvalScreen';
import { AddOnlineEvalScreen } from './AddOnlineEvalScreen';
import type { AddOnlineEvalConfig, EvaluatorItem } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; evaluators: EvaluatorItem[]; agentNames: string[]; runtimes: RuntimeInfoForEval[] }
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

        const runtimesList = projectSpec.runtimes ?? [];
        const agentNames = runtimesList.map(a => a.name);

        if (agentNames.length === 0) {
          setFlow({
            name: 'error',
            message: 'No agents found in project. Add an agent first with `agentcore add agent`.',
          });
          return;
        }

        // Build runtime info with endpoints for the endpoint picker
        const runtimesInfo: RuntimeInfoForEval[] = runtimesList.map(r => ({
          name: r.name,
          endpoints: Object.entries(r.endpoints ?? {}).map(([epName, ep]) => ({
            name: epName,
            version: ep.version,
          })),
        }));

        setFlow({ name: 'create-wizard', evaluators: items, agentNames, runtimes: runtimesInfo });
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
    return <GradientText text="Preparing online eval setup..." />;
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
        runtimes={flow.runtimes}
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
