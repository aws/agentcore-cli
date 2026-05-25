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

type EvalSource = 'dataset' | 'traces';

type FlowState =
  | { name: 'loading' }
  | { name: 'source-picker'; data: RunEvalFlowData }
  | { name: 'wizard'; data: RunEvalFlowData; source: EvalSource; dataset?: string; datasetVersion?: string }
  | { name: 'running'; config: RunEvalConfig; progressMessage?: string }
  | { name: 'results'; result: RunEvalResult; run: EvalRunResult; filePath: string }
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
          const agentStates = target.resources?.runtimes;
          if (agentStates) {
            for (const name of Object.keys(agentStates)) {
              deployedAgentNames.add(name);
            }
          }
        }

        const agents: AgentItem[] = context.project.runtimes
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
                context.project.runtimes.length === 0
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

        setFlow({ name: 'source-picker', data: { agents, evaluators } });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  const handleRunComplete = useCallback(
    (config: RunEvalConfig) => {
      // Inject dataset info from source-picker selection
      if (flow.name === 'wizard' && flow.source === 'dataset') {
        config = { ...config, dataset: flow.dataset, datasetVersion: flow.datasetVersion };
      }
      const isDataset = flow.name === 'wizard' && flow.source === 'dataset';
      const progressMessage = isDataset
        ? 'Running dataset evaluation: loading scenarios → invoking agent → collecting spans → evaluating...'
        : undefined;
      setFlow({ name: 'running', config, progressMessage });
    },
    [flow]
  );

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
          assertions: config.assertions.length > 0 ? config.assertions : undefined,
          expectedTrajectory: config.expectedTrajectory.length > 0 ? config.expectedTrajectory : undefined,
          expectedResponse: config.expectedResponse || undefined,
          dataset: config.dataset,
          datasetVersion: config.datasetVersion,
          onProgress: config.dataset
            ? (_phase, message) => {
                if (!cancelled)
                  setFlow(prev => (prev.name === 'running' ? { ...prev, progressMessage: message } : prev));
              }
            : undefined,
        });

        if (cancelled) return;

        if (!result.success) {
          setFlow({ name: 'error', message: result.error.message });
          return;
        }

        setFlow({ name: 'results', result, run: result.run, filePath: result.filePath });
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

  if (flow.name === 'source-picker') {
    return (
      <EvalSourcePicker
        data={flow.data}
        onSelect={(source, dataset, datasetVersion) => {
          if (source === 'traces') {
            setFlow({ name: 'wizard', data: flow.data, source: 'traces' });
          } else {
            setFlow({ name: 'wizard', data: flow.data, source: 'dataset', dataset, datasetVersion });
          }
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'wizard') {
    return (
      <RunEvalScreen
        agents={flow.data.agents}
        evaluatorItems={flow.data.evaluators}
        source={flow.source}
        onComplete={handleRunComplete}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'running') {
    const message = flow.progressMessage ?? 'Running evaluation... this may take a few minutes';
    return (
      <Screen title="Run On-demand Evaluation" onExit={onExit}>
        <GradientText text={message} />
      </Screen>
    );
  }

  if (flow.name === 'results') {
    return (
      <ResultsView
        run={flow.run}
        filePath={flow.filePath}
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
// Evaluation source picker
// ─────────────────────────────────────────────────────────────────────────────

interface EvalSourcePickerProps {
  data: RunEvalFlowData;
  onSelect: (source: EvalSource, dataset?: string, datasetVersion?: string) => void;
  onExit: () => void;
}

function EvalSourcePicker({ data: _data, onSelect, onExit }: EvalSourcePickerProps) {
  const [step, setStep] = useState<'source' | 'dataset' | 'version'>('source');
  const [datasets, setDatasets] = useState<string[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<string>('');
  const [versionItems, setVersionItems] = useState<{ id: string; title: string; description: string }[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // Load dataset names from project config
  useEffect(() => {
    void (async () => {
      try {
        const { ConfigIO } = await import('../../../../lib');
        const configIO = new ConfigIO();
        const spec = await configIO.readProjectSpec();
        setDatasets((spec.datasets ?? []).map(d => d.name));
      } catch {
        // No datasets available
      }
    })();
  }, []);

  // Load versions when a dataset is selected
  useEffect(() => {
    if (step !== 'version' || !selectedDataset) return;
    let cancelled = false;
    setLoadingVersions(true);

    void (async () => {
      try {
        const { resolveDataset } = await import('../../../operations/dataset/resolve-dataset');
        const { listDatasetVersions } = await import('../../../aws/agentcore-datasets');
        const resolved = await resolveDataset(selectedDataset);
        const result = await listDatasetVersions({ region: resolved.region, datasetId: resolved.datasetId });

        if (cancelled) return;

        const items: { id: string; title: string; description: string }[] = [
          { id: 'local', title: 'Local file', description: 'fastest iteration, no push required' },
          { id: 'DRAFT', title: 'DRAFT', description: 'latest pushed content' },
        ];
        for (const v of result.versions.sort((a, b) => b.createdAt - a.createdAt)) {
          const date = new Date(v.createdAt * 1000).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          items.push({
            id: v.datasetVersion,
            title: `Version ${v.datasetVersion}`,
            description: `${v.exampleCount} examples · ${date}`,
          });
        }
        setVersionItems(items);
      } catch {
        // If versions can't be loaded (not deployed yet), just offer local + DRAFT
        setVersionItems([
          { id: 'local', title: 'Local file', description: 'fastest iteration, no push required' },
          { id: 'DRAFT', title: 'DRAFT', description: 'latest pushed content' },
        ]);
      } finally {
        if (!cancelled) setLoadingVersions(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step, selectedDataset]);

  const sourceItems = [
    { id: 'dataset', title: 'Dataset', description: 'Invoke agent with dataset scenarios' },
    { id: 'traces', title: 'Historical traces', description: 'Evaluate existing sessions' },
  ];

  const datasetItems = datasets.map(name => ({
    id: name,
    title: name,
  }));

  const handleDatasetSelected = useCallback(
    (name: string) => {
      setSelectedDataset(name);
      setStep('version');
    },
    [setSelectedDataset, setStep]
  );

  const sourceNav = useListNavigation({
    items: sourceItems,
    onSelect: (item: { id: string }) => {
      if (item.id === 'traces') {
        onSelect('traces');
      } else {
        if (datasets.length === 1) {
          handleDatasetSelected(datasets[0]!);
        } else if (datasets.length > 1) {
          setStep('dataset');
        } else {
          onSelect('dataset');
        }
      }
    },
    onExit,
    isActive: step === 'source',
  });

  const datasetNav = useListNavigation({
    items: datasetItems,
    onSelect: (item: { id: string }) => {
      handleDatasetSelected(item.id);
    },
    onExit: () => setStep('source'),
    isActive: step === 'dataset',
  });

  const versionNav = useListNavigation({
    items: versionItems,
    onSelect: (item: { id: string }) => {
      const version = item.id === 'local' ? undefined : item.id;
      onSelect('dataset', selectedDataset, version);
    },
    onExit: () => (datasets.length > 1 ? setStep('dataset') : setStep('source')),
    isActive: step === 'version' && !loadingVersions,
  });

  if (step === 'version') {
    return (
      <Screen
        title="Run On-demand Evaluation"
        onExit={() => (datasets.length > 1 ? setStep('dataset') : setStep('source'))}
      >
        <Box flexDirection="column">
          <Text bold>Select version for {selectedDataset}:</Text>
          {loadingVersions ? (
            <GradientText text="Loading versions..." />
          ) : (
            <>
              {versionItems.map((item, i) => (
                <Text key={item.id}>
                  {i === versionNav.selectedIndex ? <Text color="cyan">❯ </Text> : '  '}
                  <Text color={i === versionNav.selectedIndex ? 'cyan' : undefined}>{item.title}</Text>
                  <Text dimColor> — {item.description}</Text>
                </Text>
              ))}
              <Text dimColor>{'\n'}↑↓ Enter select · Esc back</Text>
            </>
          )}
        </Box>
      </Screen>
    );
  }

  if (step === 'dataset') {
    return (
      <Screen title="Run On-demand Evaluation" onExit={() => setStep('source')}>
        <Box flexDirection="column">
          <Text bold>Select dataset:</Text>
          {datasetItems.map((item, i) => (
            <Text key={item.id}>
              {i === datasetNav.selectedIndex ? <Text color="cyan">❯ </Text> : '  '}
              <Text color={i === datasetNav.selectedIndex ? 'cyan' : undefined}>{item.title}</Text>
            </Text>
          ))}
          <Text dimColor>{'\n'}↑↓ Enter select · Esc back</Text>
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title="Run On-demand Evaluation" onExit={onExit}>
      <Box flexDirection="column">
        <Text bold>Evaluation source:</Text>
        {sourceItems.map((item, i) => (
          <Text key={item.id}>
            {i === sourceNav.selectedIndex ? <Text color="cyan">❯ </Text> : '  '}
            <Text color={i === sourceNav.selectedIndex ? 'cyan' : undefined}>{item.title}</Text>
            <Text dimColor> — {item.description}</Text>
          </Text>
        ))}
        <Text dimColor>{'\n'}↑↓ Enter select · Esc back</Text>
      </Box>
    </Screen>
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
            {run.lookbackDays != null && (
              <>
                {'  '}
                <Text bold>Lookback:</Text> {run.lookbackDays}d
              </>
            )}
            {run.datasetName && (
              <>
                {'  '}
                <Text bold>Dataset:</Text> {run.datasetName}
              </>
            )}
          </Text>
          {run.referenceInputs && (
            <Text dimColor>
              Reference inputs:{' '}
              {[
                run.referenceInputs.assertions?.length ? `${run.referenceInputs.assertions.length} assertion(s)` : '',
                run.referenceInputs.expectedResponse ? 'expected response' : '',
                run.referenceInputs.expectedTrajectory?.length
                  ? `${run.referenceInputs.expectedTrajectory.length} trajectory step(s)`
                  : '',
              ]
                .filter(Boolean)
                .join(', ')}
            </Text>
          )}

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
