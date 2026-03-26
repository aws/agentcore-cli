import { ErrorPrompt } from '../../components';
import { useCreateEvaluator, useExistingEvaluatorNames } from '../../hooks/useCreateEvaluator';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddEvaluatorScreen } from './AddEvaluatorScreen';
import type { AddEvaluatorConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; evaluatorName: string }
  | { name: 'error'; message: string };

interface AddEvaluatorFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddEvaluatorFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddEvaluatorFlowProps) {
  const { createEvaluator, reset: resetCreate } = useCreateEvaluator();
  const { names: existingNames } = useExistingEvaluatorNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddEvaluatorConfig) => {
      void createEvaluator(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', evaluatorName: result.evaluatorName });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createEvaluator]
  );

  if (flow.name === 'create-wizard') {
    return (
      <AddEvaluatorScreen existingEvaluatorNames={existingNames} onComplete={handleCreateComplete} onExit={onBack} />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added evaluator: ${flow.evaluatorName}`}
        detail="Evaluator added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy`."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add evaluator"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
