import { ConfigIO } from '../../../../lib';
import type { DeployedState } from '../../../../schema';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { InsightsJobRecord } from '../../../operations/jobs/shared/types';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { ErrorPrompt, GradientText, SuccessPrompt } from '../../components';
import { RunInsightsScreen } from './RunInsightsScreen';
import type { RunInsightsConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; agentNames: string[]; onlineEvalConfigArns: string[] }
  | { name: 'submitting' }
  | { name: 'success'; record: InsightsJobRecord }
  | { name: 'error'; message: string };

interface RunInsightsFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onViewJobs?: () => void;
}

export function RunInsightsFlow({ isInteractive = true, onExit, onBack, onViewJobs }: RunInsightsFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);

  useEffect(() => {
    if (flow.name !== 'loading') return;
    let cancelled = false;

    void (async () => {
      try {
        const configIO = new ConfigIO();
        const [projectSpec, deployedState] = await Promise.all([
          configIO.readProjectSpec(),
          configIO.readDeployedState(),
        ]);
        if (cancelled) return;

        const agentNames = (projectSpec.runtimes ?? []).map(a => a.name);
        if (agentNames.length === 0) {
          setFlow({
            name: 'error',
            message: 'No agents found in project. Add an agent first with `agentcore add agent`.',
          });
          return;
        }

        const onlineEvalConfigArns = extractOnlineEvalConfigArns(deployedState);

        setFlow({ name: 'wizard', agentNames, onlineEvalConfigArns });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  useEffect(() => {
    if (!isInteractive && flow.name === 'success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleComplete = useCallback(
    (config: RunInsightsConfig) => {
      setFlow({ name: 'submitting' });

      void (async () => {
        try {
          const startResult = await withCommandRunTelemetry('run.job', { job_type: 'insights', has_wait: false }, () =>
            engine.start('insights', {
              agent: config.agent || undefined,
              insights: config.insights.length > 0 ? config.insights : ['Builtin.Insight.FailureAnalysis'],
              onlineEvalConfigArn: config.source === 'online-eval-config' ? config.onlineEvalConfigArn : undefined,
              lookbackDays: config.source === 'agent' ? config.lookbackDays : undefined,
              sessionIds: config.sessionIds.length > 0 ? config.sessionIds : undefined,
              name: config.name || undefined,
            })
          );

          if (!startResult.success) {
            throw startResult.error ?? new Error('Failed to start insights job');
          }
          setFlow({ name: 'success', record: startResult.record });
        } catch (err) {
          setFlow({ name: 'error', message: getErrorMessage(err) });
        }
      })();
    },
    [engine]
  );

  if (flow.name === 'loading' || flow.name === 'submitting') {
    return <GradientText text={flow.name === 'loading' ? 'Loading project data...' : 'Starting insights job...'} />;
  }

  if (flow.name === 'wizard') {
    return (
      <RunInsightsScreen
        agentNames={flow.agentNames}
        onlineEvalConfigArns={flow.onlineEvalConfigArns}
        onComplete={handleComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'success') {
    return (
      <SuccessPrompt
        message={`Insights job started: ${flow.record.id}`}
        detail={`Status: ${flow.record.status}. Job is running asynchronously.\nCheck status: agentcore view insights ${flow.record.id}`}
        onConfirm={onViewJobs ?? onBack}
        confirmText={onViewJobs ? 'View Insights Jobs' : 'Back'}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to start insights job"
      detail={flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

function extractOnlineEvalConfigArns(deployedState: DeployedState): string[] {
  const arns: string[] = [];
  for (const target of Object.values(deployedState.targets ?? {})) {
    const configs = target?.resources?.onlineEvalConfigs ?? {};
    for (const config of Object.values(configs)) {
      if (config.onlineEvaluationConfigArn) {
        arns.push(config.onlineEvaluationConfigArn);
      }
    }
  }
  return arns;
}
