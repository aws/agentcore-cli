import { validateAwsCredentials } from '../../../aws/account';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import { handleRunEval } from '../../../operations/eval';
import type { RunEvalResult } from '../../../operations/eval/run-eval';
import type { EvalRunResult } from '../../../operations/eval/types';
import { loadDeployedProjectConfig } from '../../../operations/resolve-agent';
import { ErrorPrompt, GradientText, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import type { EvaluatorItem } from '../online-eval/types';
import { RunEvalScreen } from './RunEvalScreen';
import type { AgentItem, RunEvalConfig, RunEvalFlowData } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; data: RunEvalFlowData }
  | { name: 'running'; config: RunEvalConfig }
  | { name: 'results'; result: RunEvalResult; run: EvalRunResult }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string };

interface RunEvalFlowProps {
  onExit: () => void;
  onViewRuns?: () => void;
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

function shortEvalName(name: string): string {
  return name.replace(/^Builtin\./, '');
}

export function RunEvalFlow({ onExit, onViewRuns }: RunEvalFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

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
        const { region } = await detectRegion();
        const [evalResult, context] = await Promise.all([listEvaluators({ region }), loadDeployedProjectConfig()]);

        if (cancelled) return;

        const evaluators: EvaluatorItem[] = evalResult.evaluators.map(e => ({
          arn: e.evaluatorArn,
          name: e.evaluatorName,
          type: e.evaluatorType,
          description: e.description,
        }));

        // Cross-reference project agents with deployed state to only show deployed agents
        const deployedAgentNames = new Set<string>();
        for (const target of Object.values(context.deployedState.targets)) {
          const agentStates = target.resources?.agents;
          if (agentStates) {
            for (const name of Object.keys(agentStates)) {
              deployedAgentNames.add(name);
            }
          }
        }

        const agents: AgentItem[] = context.project.agents
          .filter(a => deployedAgentNames.has(a.name))
          .map(a => ({
            name: a.name,
            build: a.build,
          }));

        if (agents.length === 0) {
          if (!cancelled) {
            setFlow({
              name: 'error',
              message:
                context.project.agents.length === 0
                  ? 'No agents found in project. Run `agentcore add agent` first.'
                  : 'No deployed agents found. Run `agentcore deploy` first.',
            });
          }
          return;
        }

        if (evaluators.length === 0) {
          if (!cancelled) {
            setFlow({
              name: 'error',
              message: 'No evaluators found in your account. Create an evaluator first.',
            });
          }
          return;
        }

        setFlow({ name: 'wizard', data: { agents, evaluators } });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  const handleRunComplete = useCallback((config: RunEvalConfig) => {
    setFlow({ name: 'running', config });
  }, []);

  // Execute the eval when we enter 'running' state
  useEffect(() => {
    if (flow.name !== 'running') return;
    let cancelled = false;

    const { config } = flow;

    void (async () => {
      try {
        const result = await handleRunEval({
          agent: config.agent,
          evaluator: [],
          evaluatorArn: config.evaluators,
          days: config.days,
          sessionIds: config.sessionIds.length > 0 ? config.sessionIds : undefined,
        });

        if (cancelled) return;

        if (!result.success || !result.run) {
          setFlow({ name: 'error', message: result.error ?? 'Evaluation failed' });
          return;
        }

        setFlow({ name: 'results', result, run: result.run });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flow.name === 'loading') {
    return (
      <Screen title="Run On-demand Evaluation" onExit={onExit}>
        <GradientText text="Loading agents and evaluators..." />
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'wizard') {
    return (
      <RunEvalScreen
        agents={flow.data.agents}
        evaluatorItems={flow.data.evaluators}
        onComplete={handleRunComplete}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'running') {
    return (
      <Screen title="Run On-demand Evaluation" onExit={onExit}>
        <GradientText text="Running evaluation... this may take a few minutes" />
      </Screen>
    );
  }

  if (flow.name === 'results') {
    return (
      <ResultsView
        run={flow.run}
        filePath={flow.result.filePath}
        onRunAnother={() => setFlow({ name: 'loading' })}
        onViewRuns={onViewRuns}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Evaluation failed"
      detail={flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Results view
// ─────────────────────────────────────────────────────────────────────────────

interface ResultsViewProps {
  run: EvalRunResult;
  filePath?: string;
  onRunAnother: () => void;
  onViewRuns?: () => void;
  onExit: () => void;
}

function ResultsView({ run, filePath, onRunAnother, onViewRuns, onExit }: ResultsViewProps) {
  const actions = [
    { id: 'another', title: 'Run another evaluation' },
    ...(onViewRuns ? [{ id: 'view-runs', title: 'View eval runs' }] : []),
    { id: 'back', title: 'Back' },
  ];

  const nav = useListNavigation({
    items: actions,
    onSelect: item => {
      if (item.id === 'another') onRunAnother();
      else if (item.id === 'view-runs') onViewRuns?.();
      else onExit();
    },
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Evaluation Complete" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="green">✓ Evaluation complete</Text>
          <Text>
            <Text bold>Agent:</Text> {run.agent}
            {'  '}
            <Text bold>Sessions:</Text> {run.sessionCount}
            {'  '}
            <Text bold>Lookback:</Text> {run.lookbackDays}d
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Scores range from 0 (worst) to 1 (best).</Text>
            {run.results.map((r, i) => {
              const errCount = r.sessionScores.filter(s => s.errorMessage).length;
              return (
                <Text key={i}>
                  {'  '}
                  <Text bold>{shortEvalName(r.evaluator)}</Text>
                  {'  '}
                  <Text color={scoreColor(r.aggregateScore)}>{r.aggregateScore.toFixed(2)}</Text>
                  {errCount > 0 && <Text color={STATUS_COLORS.error}> ({errCount} errors)</Text>}
                </Text>
              );
            })}
          </Box>

          {filePath && (
            <Box marginTop={1}>
              <Text dimColor>Results saved to: {filePath}</Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            {actions.map((action, idx) => {
              const selected = idx === nav.selectedIndex;
              return (
                <Text key={action.id}>
                  <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                  <Text color={selected ? 'cyan' : undefined} bold={selected}>
                    {action.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      </Panel>
    </Screen>
  );
}
