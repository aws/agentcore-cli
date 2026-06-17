import { ConfigIO } from '../../../../lib';
import { getErrorMessage } from '../../../errors';
import { onlineInsightsPrimitive } from '../../../primitives/registry';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { ErrorPrompt, GradientText } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddOnlineInsightsScreen } from './AddOnlineInsightsScreen';
import type { AddOnlineInsightsConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; agentNames: string[] }
  | { name: 'create-success'; configName: string }
  | { name: 'error'; message: string };

interface AddOnlineInsightsFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddOnlineInsightsFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddOnlineInsightsFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [existingConfigNames, setExistingConfigNames] = useState<string[]>([]);

  // Load project data
  useEffect(() => {
    if (flow.name !== 'loading') return;
    let cancelled = false;

    void (async () => {
      try {
        const projectSpec = await new ConfigIO().readProjectSpec();
        if (cancelled) return;

        const runtimesList = projectSpec.runtimes ?? [];
        const agentNames = runtimesList.map(a => a.name);

        if (agentNames.length === 0) {
          setFlow({
            name: 'error',
            message: 'No agents found in project. Add an agent first with `agentcore add agent`.',
          });
          return;
        }

        const names = await onlineInsightsPrimitive.getAllNames();
        if (cancelled) return;
        setExistingConfigNames(names);

        setFlow({ name: 'create-wizard', agentNames });
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

  const handleCreateComplete = useCallback((config: AddOnlineInsightsConfig) => {
    void (async () => {
      try {
        const addResult = await withCommandRunTelemetry(
          'add.online-insights',
          {
            insights_count: config.insights.length,
            enable_on_create: config.enableOnCreate,
          },
          () =>
            onlineInsightsPrimitive.add({
              name: config.name,
              agent: config.agent,
              insights: config.insights,
              samplingRate: config.samplingRate,
              clusteringFrequencies: config.clusteringFrequencies.length > 0 ? config.clusteringFrequencies : undefined,
              enableOnCreate: config.enableOnCreate,
            })
        );
        if (!addResult.success) {
          throw new Error(addResult.error?.message ?? 'Failed to create online insights config');
        }
        setFlow({ name: 'create-success', configName: config.name });
      } catch (err) {
        setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();
  }, []);

  if (flow.name === 'loading') {
    return <GradientText text="Preparing online insights setup..." />;
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddOnlineInsightsScreen
        existingConfigNames={existingConfigNames}
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
        message={`Added online insights config: ${flow.configName}`}
        detail="Online insights config added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy`."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add online insights config"
      detail={flow.message}
      onBack={() => {
        setFlow({ name: 'loading' });
      }}
      onExit={onExit}
    />
  );
}
