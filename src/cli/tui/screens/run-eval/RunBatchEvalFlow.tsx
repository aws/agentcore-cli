import { ConfigIO } from '../../../../lib';
import { isValidKmsKeyArn } from '../../../../schema';
import { validateAwsCredentials } from '../../../aws/account';
import type { SessionMetadataEntry } from '../../../aws/agentcore-batch-evaluation';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import type { SessionInfo } from '../../../operations/eval';
import { discoverSessions } from '../../../operations/eval';
import { runDatasetScenarios } from '../../../operations/eval/shared/dataset-session-provider';
import { resolveAgentContext } from '../../../operations/invoke/resolve-agent-context';
import { createJobEngine } from '../../../operations/jobs';
import type { BatchEvaluationJobRecord } from '../../../operations/jobs';
import { loadDeployedProjectConfig, resolveAgent } from '../../../operations/resolve-agent';
import {
  ConfirmReview,
  ErrorPrompt,
  GradientText,
  Panel,
  PathInput,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import type { EvaluatorItem } from '../online-eval/types';
import { GroundTruthForm } from './GroundTruthForm';
import type { AgentItem } from './types';
import type { GroundTruthData } from './useRunEvalWizard';
import { Box, Text } from 'ink';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

const DEFAULT_LOOKBACK_DAYS = 7;

/** Delay before submitting batch eval to allow CloudWatch span ingestion. Matches SDK default. */
const BATCH_INGESTION_DELAY_MS = 180_000;

// 'source' is a breadcrumb-only step (the source-picker) — it is NOT part of the wizard's
// navigable steps, only shown in the StepIndicator so the picker and wizard share one header.
type BatchEvalStep =
  | 'source'
  | 'agent'
  | 'evaluators'
  | 'days'
  | 'sessions'
  | 'ground-truth'
  | 'kms-key-arn'
  | 'name'
  | 'confirm';

interface BatchEvalConfig {
  agent: string;
  evaluators: string[];
  evaluatorNames: string[];
  days: number;
  sessionIds: string[];
  groundTruthFile: string;
  sessionMetadata?: SessionMetadataEntry[];
  kmsKeyArn: string;
  name: string;
  dataset?: string;
  datasetVersion?: string;
}

const STEP_LABELS: Record<BatchEvalStep, string> = {
  source: 'Source',
  agent: 'Agent',
  evaluators: 'Evaluators',
  days: 'Lookback',
  sessions: 'Sessions',
  'ground-truth': 'Ground Truth',
  'kms-key-arn': 'KMS Key',
  name: 'Name',
  confirm: 'Confirm',
};

type EvalSource = 'dataset' | 'traces';

type FlowState =
  | { name: 'loading' }
  | { name: 'source-picker'; agents: AgentItem[]; evaluators: EvaluatorItem[] }
  | {
      name: 'wizard';
      agents: AgentItem[];
      evaluators: EvaluatorItem[];
      source: EvalSource;
      dataset?: string;
      datasetVersion?: string;
    }
  // Dataset mode only: blocking Phase-1 invocation of dataset scenarios before engine.start.
  | { name: 'phase1'; config: BatchEvalConfig; message: string }
  | { name: 'starting'; config: BatchEvalConfig }
  | { name: 'started'; record: BatchEvaluationJobRecord; config: BatchEvalConfig }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string };

// ============================================================================
// Flow Component
// ============================================================================

interface RunBatchEvalFlowProps {
  onExit: () => void;
  /** Navigate to the Batch Eval Jobs screen (falls back to onExit when not provided). */
  onViewJobs?: () => void;
}

export function RunBatchEvalFlow({ onExit, onViewJobs }: RunBatchEvalFlowProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // Load agents and evaluators
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
        const context = await loadDeployedProjectConfig();
        const targetRegion = context.awsTargets?.[0]?.region;
        const { region: detectedRegion } = await detectRegion();
        const region = targetRegion ?? detectedRegion;
        const evalResult = await listEvaluators({ region });

        if (cancelled) return;

        const evaluators: EvaluatorItem[] = evalResult.evaluators.map(e => ({
          arn: e.evaluatorArn,
          name: e.evaluatorName,
          type: e.evaluatorType,
          description: e.description,
        }));

        // Only show deployed agents
        const deployedAgentNames = new Set<string>();
        for (const target of Object.values(context.deployedState.targets)) {
          const runtimeStates = target.resources?.runtimes;
          if (runtimeStates) {
            for (const name of Object.keys(runtimeStates)) {
              deployedAgentNames.add(name);
            }
          }
        }

        const agents: AgentItem[] = context.project.runtimes
          .filter((a: { name: string }) => deployedAgentNames.has(a.name))
          .map((a: { name: string; build: string }) => ({ name: a.name, build: a.build }));

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
            setFlow({ name: 'error', message: 'No evaluators found in your account. Create an evaluator first.' });
          }
          return;
        }

        setFlow({ name: 'source-picker', agents, evaluators });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  const handleWizardComplete = useCallback(
    (config: BatchEvalConfig) => {
      // Dataset mode needs a blocking pre-start phase ('phase1': invoke scenarios + ~180s ingestion
      // wait) to produce the sessionIds before starting. Historical-traces mode already has its
      // sessions (collected in the wizard), so it skips straight to 'starting'. That asymmetry is
      // intentional — only dataset mode has pre-start work.
      const isDataset = flow.name === 'wizard' && flow.source === 'dataset';
      if (isDataset && flow.name === 'wizard') {
        // Inject dataset info from source-picker selection
        const datasetConfig = { ...config, dataset: flow.dataset, datasetVersion: flow.datasetVersion };
        setFlow({
          name: 'phase1',
          config: datasetConfig,
          message: `Loading dataset "${flow.dataset ?? 'default'}"...`,
        });
      } else {
        setFlow({ name: 'starting', config });
      }
    },
    [flow]
  );

  // Phase 1 (dataset mode only): invoke dataset scenarios, build ground-truth metadata, then start.
  useEffect(() => {
    if (flow.name !== 'phase1') return;
    let cancelled = false;

    const { config } = flow;

    void (async () => {
      try {
        const configIO = new ConfigIO();
        const [projectSpec, deployedState, awsTargets] = await Promise.all([
          configIO.readProjectSpec(),
          configIO.readDeployedState(),
          configIO.resolveAWSDeploymentTargets(),
        ]);

        const agentContext = await resolveAgentContext({
          project: projectSpec,
          deployedState,
          awsTargets,
          agentName: config.agent,
        });

        if (cancelled) return;

        const datasetResult = await runDatasetScenarios({
          agentContext,
          datasetName: config.dataset!,
          version: config.datasetVersion,
          configBaseDir: configIO.getConfigRoot(),
          onProgress: (_phase, msg) => {
            if (!cancelled) setFlow(prev => (prev.name === 'phase1' ? { ...prev, message: msg } : prev));
          },
        });

        if (cancelled) return;

        const successfulResults = datasetResult.scenarioResults.filter(r => r.status === 'success');
        if (successfulResults.length === 0) {
          setFlow({ name: 'error', message: 'All scenarios failed during invocation. No sessions to evaluate.' });
          return;
        }

        const sessionIds = successfulResults.map(r => r.sessionId);

        // Build sessionMetadata with ground truth from dataset scenarios
        const sessionMetadata: SessionMetadataEntry[] = successfulResults.map(r => {
          const scenario = datasetResult.scenarios.find(s => s.scenario_id === r.scenarioId);
          return {
            sessionId: r.sessionId,
            testScenarioId: r.scenarioId,
            groundTruth: scenario
              ? {
                  inline: {
                    ...(scenario.assertions ? { assertions: scenario.assertions.map(a => ({ text: a })) } : {}),
                    ...(scenario.expected_trajectory
                      ? { expectedTrajectory: { toolNames: scenario.expected_trajectory } }
                      : {}),
                    ...(scenario.turns.some(t => t.expectedResponse)
                      ? {
                          turns: scenario.turns.map(t => ({
                            input: { prompt: t.input },
                            ...(t.expectedResponse ? { expectedResponse: { text: t.expectedResponse } } : {}),
                          })),
                        }
                      : {}),
                  },
                }
              : undefined,
          };
        }) as SessionMetadataEntry[];

        setFlow(prev =>
          prev.name === 'phase1' ? { ...prev, message: 'Waiting 180s for CloudWatch span ingestion...' } : prev
        );

        // Wait for CloudWatch span ingestion before submitting — the batch service
        // queries CloudWatch server-side, so we can't poll. Match SDK default (180s).
        await sleep(BATCH_INGESTION_DELAY_MS);
        if (cancelled) return;

        setFlow({ name: 'starting', config: { ...config, sessionIds, sessionMetadata } });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire-and-forget: start the batch evaluation job, then show the Started confirmation screen.
  useEffect(() => {
    if (flow.name !== 'starting') return;
    let cancelled = false;

    const { config } = flow;

    void (async () => {
      try {
        const result = await engine.start('batch-evaluation', {
          agent: config.agent,
          evaluators: config.evaluators,
          name: config.name || undefined,
          sessionIds: config.sessionIds.length > 0 ? config.sessionIds : undefined,
          lookbackDays: config.days,
          sessionMetadata: config.sessionMetadata,
          source: config.dataset ? 'dataset' : 'traces',
          dataset: config.dataset ? { id: config.dataset, version: config.datasetVersion ?? 'LOCAL' } : undefined,
          kmsKeyArn: config.kmsKeyArn || undefined,
        });

        if (cancelled) return;

        if (!result.success) {
          setFlow({ name: 'error', message: result.error.message });
          return;
        }

        setFlow({ name: 'started', record: result.record, config });
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
      <Screen title="Run Batch Evaluation" onExit={onExit}>
        <GradientText text="Loading agents and evaluators..." />
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'source-picker') {
    return (
      <BatchEvalSourcePicker
        agents={flow.agents}
        evaluators={flow.evaluators}
        onSelect={(source, dataset, datasetVersion) => {
          if (source === 'traces') {
            setFlow({ name: 'wizard', agents: flow.agents, evaluators: flow.evaluators, source: 'traces' });
          } else {
            setFlow({
              name: 'wizard',
              agents: flow.agents,
              evaluators: flow.evaluators,
              source: 'dataset',
              dataset,
              datasetVersion,
            });
          }
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'wizard') {
    return (
      <BatchEvalWizard
        agents={flow.agents}
        evaluators={flow.evaluators}
        source={flow.source}
        dataset={flow.dataset}
        onComplete={handleWizardComplete}
        onExit={() => setFlow({ name: 'source-picker', agents: flow.agents, evaluators: flow.evaluators })}
      />
    );
  }

  if (flow.name === 'phase1') {
    return (
      <Screen title="Run Batch Evaluation" onExit={onExit}>
        <Panel>
          <Box flexDirection="column">
            <Text bold>Phase 1: invoking dataset scenarios...</Text>
            <GradientText text={flow.message} />
          </Box>
        </Panel>
      </Screen>
    );
  }

  if (flow.name === 'starting') {
    return (
      <Screen title="Run Batch Evaluation" onExit={onExit}>
        <GradientText text="Starting batch evaluation..." />
      </Screen>
    );
  }

  if (flow.name === 'started') {
    return (
      <StartedView
        record={flow.record}
        config={flow.config}
        onRunAnother={() => setFlow({ name: 'loading' })}
        onViewJobs={onViewJobs}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Batch evaluation failed"
      detail={flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

// ============================================================================
// Started confirmation view
// ============================================================================

interface StartedViewProps {
  record: BatchEvaluationJobRecord;
  config: BatchEvalConfig;
  onRunAnother: () => void;
  onViewJobs?: () => void;
  onExit: () => void;
}

function StartedView({ record, config, onRunAnother, onViewJobs, onExit }: StartedViewProps) {
  const actions = [
    { id: 'jobs', title: 'View jobs' },
    { id: 'another', title: 'Run another' },
    { id: 'back', title: 'Back' },
  ];

  const nav = useListNavigation({
    items: actions,
    onSelect: item => {
      if (item.id === 'jobs') (onViewJobs ?? onExit)();
      else if (item.id === 'another') onRunAnother();
      else onExit();
    },
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Batch Evaluation Started" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="green">
            ✓ {record.id} ({record.status})
          </Text>
          <Text>
            <Text bold>Agent:</Text> {config.agent}
            {'  '}
            <Text bold>Evaluators:</Text> {config.evaluatorNames.join(', ')}
          </Text>

          <Box marginTop={1}>
            <Text dimColor>When it completes, view it in Batch Eval Jobs.</Text>
          </Box>

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

// ============================================================================
// Wizard Component
// ============================================================================

interface BatchEvalWizardProps {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
  source?: EvalSource;
  dataset?: string;
  onComplete: (config: BatchEvalConfig) => void;
  onExit: () => void;
}

function BatchEvalWizard({
  agents,
  evaluators: rawEvaluators,
  source,
  dataset,
  onComplete,
  onExit,
}: BatchEvalWizardProps) {
  const skipAgent = agents.length <= 1;
  const isDatasetMode = source === 'dataset';
  const allSteps = useMemo<BatchEvalStep[]>(() => {
    if (isDatasetMode) {
      return skipAgent
        ? ['evaluators', 'kms-key-arn', 'name', 'confirm']
        : ['agent', 'evaluators', 'kms-key-arn', 'name', 'confirm'];
    }
    return skipAgent
      ? ['evaluators', 'days', 'sessions', 'ground-truth', 'kms-key-arn', 'name', 'confirm']
      : ['agent', 'evaluators', 'days', 'sessions', 'ground-truth', 'kms-key-arn', 'name', 'confirm'];
  }, [skipAgent, isDatasetMode]);

  const [step, setStep] = useState<BatchEvalStep>(allSteps[0]!);
  const [config, setConfig] = useState<BatchEvalConfig>({
    agent: skipAgent ? agents[0]!.name : '',
    evaluators: [],
    evaluatorNames: [],
    days: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
    groundTruthFile: '',
    sessionMetadata: undefined,
    kmsKeyArn: '',
    name: '',
  });

  const currentIndex = allSteps.indexOf(step);
  const [groundTruthError, setGroundTruthError] = useState<string | null>(null);
  const [gtMode, setGtMode] = useState<'choose' | 'file' | 'inline'>('choose');

  const goBack = useCallback(() => {
    const prev = allSteps[currentIndex - 1];
    if (prev) {
      if (prev === 'ground-truth') setGtMode('choose');
      setStep(prev);
    } else onExit();
  }, [allSteps, currentIndex, onExit]);

  const goNext = useCallback(() => {
    const next = allSteps[currentIndex + 1];
    if (next) setStep(next);
  }, [allSteps, currentIndex]);

  const agentItems: SelectableItem[] = useMemo(
    () => agents.map(a => ({ id: a.name, title: a.name, description: a.build })),
    [agents]
  );

  const evaluatorItems: SelectableItem[] = useMemo(
    () =>
      rawEvaluators.map(e => ({
        id: e.arn,
        title: e.name,
        description: e.type === 'Builtin' ? 'Built-in evaluator' : (e.description ?? 'Custom evaluator'),
      })),
    [rawEvaluators]
  );

  // ── Session discovery ──────────────────────────────────────────────────────

  type SessionResult = { phase: 'loaded'; sessions: SessionInfo[] } | { phase: 'error'; message: string };

  const [sessionResult, setSessionResult] = useState<SessionResult & { key: string }>();
  const fetchingRef = useRef('');

  const isAgentStep = step === 'agent';
  const isEvaluatorsStep = step === 'evaluators';
  const isDaysStep = step === 'days';
  const isSessionsStep = step === 'sessions';
  const isGroundTruthStep = step === 'ground-truth';
  const isKmsKeyArnStep = step === 'kms-key-arn';
  const isNameStep = step === 'name';
  const isConfirmStep = step === 'confirm';

  const fetchKey = `${config.agent}:${config.days}`;
  const sessionPhase = !isSessionsStep ? 'idle' : sessionResult?.key === fetchKey ? sessionResult.phase : 'loading';

  useEffect(() => {
    if (!isSessionsStep) return;
    if (sessionResult?.key === fetchKey) return;
    if (fetchingRef.current === fetchKey) return;
    fetchingRef.current = fetchKey;
    let cancelled = false;

    void (async () => {
      try {
        const context = await loadDeployedProjectConfig();
        const targetRegion = context.awsTargets?.[0]?.region;
        const { region: detectedRegion } = await detectRegion();
        const region = targetRegion ?? detectedRegion;
        const agentResult = resolveAgent(context, { runtime: config.agent });
        if (!agentResult.success) {
          if (!cancelled) setSessionResult({ key: fetchKey, phase: 'error', message: agentResult.error });
          return;
        }

        const sessions = await discoverSessions({
          runtimeId: agentResult.agent.runtimeId,
          region,
          lookbackDays: config.days,
        });

        if (cancelled) return;

        if (sessions.length === 0) {
          setSessionResult({
            key: fetchKey,
            phase: 'error',
            message: 'No sessions found in the lookback window. Try increasing the lookback days.',
          });
        } else {
          setSessionResult({ key: fetchKey, phase: 'loaded', sessions });
        }
      } catch (err) {
        if (!cancelled) {
          setSessionResult({
            key: fetchKey,
            phase: 'error',
            message: err instanceof Error ? err.message : 'Failed to discover sessions',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSessionsStep, fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionItems: SelectableItem[] = useMemo(() => {
    const sessions = sessionResult?.phase === 'loaded' ? sessionResult.sessions : [];
    return sessions.map(s => {
      const date = s.firstSeen
        ? new Date(s.firstSeen).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      const shortId = s.sessionId.length > 36 ? s.sessionId.slice(0, 36) + '…' : s.sessionId;
      return {
        id: s.sessionId,
        title: shortId,
        description: `${s.spanCount} spans · ${date}`,
      };
    });
  }, [sessionResult]);

  // ── Navigation hooks ──────────────────────────────────────────────────────

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => {
      setConfig(c => ({ ...c, agent: item.id }));
      goNext();
    },
    onExit,
    isActive: isAgentStep,
  });

  const evaluatorsNav = useMultiSelectNavigation({
    items: evaluatorItems,
    getId: item => item.id,
    onConfirm: ids => {
      const names = ids.map(id => {
        const item = rawEvaluators.find(e => e.arn === id);
        return item?.name ?? id;
      });
      setConfig(c => ({ ...c, evaluators: ids, evaluatorNames: names }));
      goNext();
    },
    onExit: () => goBack(),
    isActive: isEvaluatorsStep,
    requireSelection: true,
  });

  // Handle Esc during session loading/error
  useListNavigation({
    items: [{ id: 'back', title: 'Back' }],
    onSelect: () => goBack(),
    onExit: () => goBack(),
    isActive: isSessionsStep && sessionPhase !== 'loaded',
  });

  const sessionsNav = useMultiSelectNavigation({
    items: sessionItems,
    getId: item => item.id,
    onConfirm: ids => {
      setConfig(c => ({ ...c, sessionIds: ids }));
      goNext();
    },
    onExit: () => goBack(),
    isActive: isSessionsStep && sessionPhase === 'loaded',
    requireSelection: true,
  });

  const gtChoiceItems: SelectableItem[] = useMemo(
    () => [
      { id: 'skip', title: 'Skip', description: 'No ground truth' },
      { id: 'file', title: 'Load from file', description: 'JSON file with session metadata and ground truth' },
      { id: 'inline', title: 'Enter manually', description: 'Type assertions, trajectory, and expected response' },
    ],
    []
  );

  const gtChoiceNav = useListNavigation({
    items: gtChoiceItems,
    onSelect: item => {
      setGroundTruthError(null);
      if (item.id === 'skip') {
        setConfig(c => ({ ...c, groundTruthFile: '', sessionMetadata: undefined }));
        goNext();
      } else if (item.id === 'file') {
        setGtMode('file');
      } else {
        setGtMode('inline');
      }
    },
    onExit: () => goBack(),
    isActive: isGroundTruthStep && gtMode === 'choose',
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(config),
    onExit: () => goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isAgentStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isEvaluatorsStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isDaysStep
        ? HELP_TEXT.TEXT_INPUT
        : isSessionsStep
          ? sessionPhase === 'loading'
            ? ''
            : sessionPhase === 'error'
              ? HELP_TEXT.CONFIRM_CANCEL
              : 'Space toggle · Enter confirm · Esc back'
          : isGroundTruthStep
            ? gtMode === 'choose'
              ? HELP_TEXT.NAVIGATE_SELECT
              : gtMode === 'file'
                ? HELP_TEXT.TEXT_INPUT
                : 'Enter value · Enter on empty to skip section · Esc back'
            : isNameStep
              ? HELP_TEXT.TEXT_INPUT
              : HELP_TEXT.CONFIRM_CANCEL;

  // Prepend the breadcrumb-only 'source' step so the wizard header matches the source-picker's
  // (it renders as a completed step here). 'source' is intentionally absent from navigable allSteps.
  const displaySteps = useMemo<BatchEvalStep[]>(() => ['source', ...allSteps], [allSteps]);
  const headerContent = <StepIndicator steps={displaySteps} currentStep={step} labels={STEP_LABELS} />;

  return (
    <Screen title="Run Batch Evaluation" onExit={goBack} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isAgentStep && (
          <WizardSelect
            title="Select agent to evaluate"
            description="Choose a deployed agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isEvaluatorsStep && (
          <WizardMultiSelect
            title="Select evaluators"
            description="Choose evaluators to run against agent sessions"
            items={evaluatorItems}
            cursorIndex={evaluatorsNav.cursorIndex}
            selectedIds={evaluatorsNav.selectedIds}
            maxVisibleItems={10}
          />
        )}

        {isDaysStep && (
          <Box flexDirection="column">
            <Text dimColor>Note: Traces may take 5–10 min to appear after agent invocations.</Text>
            <TextInput
              key="days"
              prompt="Lookback window (days)"
              initialValue={String(DEFAULT_LOOKBACK_DAYS)}
              onSubmit={value => {
                const days = parseInt(value, 10);
                if (!isNaN(days) && days >= 1 && days <= 90) {
                  setConfig(c => ({ ...c, days }));
                  goNext();
                }
              }}
              onCancel={() => goBack()}
              customValidation={value => {
                const days = parseInt(value, 10);
                if (isNaN(days)) return 'Must be a number';
                if (days < 1 || days > 90) return 'Must be between 1 and 90';
                return true;
              }}
            />
          </Box>
        )}

        {isSessionsStep && sessionPhase === 'loading' && <GradientText text="Discovering sessions..." />}

        {isSessionsStep && sessionResult?.phase === 'error' && <Text color="red">{sessionResult.message}</Text>}

        {isSessionsStep && sessionPhase === 'loaded' && (
          <WizardMultiSelect
            title="Select sessions to evaluate"
            description={`Found ${sessionItems.length} session${sessionItems.length !== 1 ? 's' : ''} — select one or more`}
            items={sessionItems}
            cursorIndex={sessionsNav.cursorIndex}
            selectedIds={sessionsNav.selectedIds}
          />
        )}

        {isGroundTruthStep && gtMode === 'choose' && (
          <WizardSelect
            title="Ground truth (optional)"
            description="Provide assertions, expected trajectory, or expected responses for evaluation"
            items={gtChoiceItems}
            selectedIndex={gtChoiceNav.selectedIndex}
          />
        )}

        {isGroundTruthStep && gtMode === 'file' && (
          <Box flexDirection="column">
            <Text dimColor>Select a JSON file with session ground truth (assertions, expected trajectory, turns).</Text>
            {groundTruthError && <Text color="red">{groundTruthError}</Text>}
            <PathInput
              placeholder="path/to/ground-truth.json"
              pathType="file"
              onSubmit={value => {
                setGroundTruthError(null);
                try {
                  const resolved = resolvePath(value.trim());
                  const content = readFileSync(resolved, 'utf-8');
                  const parsed = JSON.parse(content) as Record<string, unknown>;
                  const metadata: SessionMetadataEntry[] = Array.isArray(parsed)
                    ? (parsed as SessionMetadataEntry[])
                    : (parsed.sessionMetadata as SessionMetadataEntry[]);
                  if (!Array.isArray(metadata)) {
                    setGroundTruthError('File must be a JSON array or contain a "sessionMetadata" array');
                    return;
                  }
                  setConfig(c => ({ ...c, groundTruthFile: resolved, sessionMetadata: metadata }));
                  goNext();
                } catch (err) {
                  setGroundTruthError(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`);
                }
              }}
              onCancel={() => {
                setGroundTruthError(null);
                setGtMode('choose');
              }}
            />
          </Box>
        )}

        {isGroundTruthStep && gtMode === 'inline' && (
          <GroundTruthForm
            sessionId={config.sessionIds.length === 1 ? config.sessionIds[0]! : `${config.sessionIds.length} sessions`}
            onSubmit={(gt: GroundTruthData) => {
              // Apply the same ground truth to all selected sessions
              const metadata: SessionMetadataEntry[] = config.sessionIds.map(sid => ({
                sessionId: sid,
                groundTruth: {
                  inline: {
                    ...(gt.assertions.length > 0 ? { assertions: gt.assertions.map(text => ({ text })) } : {}),
                    ...(gt.expectedTrajectory.length > 0
                      ? { expectedTrajectory: { toolNames: gt.expectedTrajectory } }
                      : {}),
                    ...(gt.expectedResponse
                      ? {
                          turns: [
                            {
                              input: { prompt: '' },
                              expectedResponse: { text: gt.expectedResponse },
                            },
                          ],
                        }
                      : {}),
                  },
                },
              }));
              setConfig(c => ({ ...c, groundTruthFile: '', sessionMetadata: metadata }));
              goNext();
            }}
            onCancel={() => {
              setGtMode('choose');
            }}
          />
        )}

        {isKmsKeyArnStep && (
          <TextInput
            key="kms-key-arn"
            prompt="KMS key ARN for encryption (optional, press Enter to skip)"
            initialValue=""
            allowEmpty
            onSubmit={value => {
              setConfig(c => ({ ...c, kmsKeyArn: value }));
              goNext();
            }}
            onCancel={() => goBack()}
            customValidation={value => {
              if (!value) return true;
              if (!isValidKmsKeyArn(value)) {
                return 'Invalid KMS key ARN (e.g. arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)';
              }
              return true;
            }}
          />
        )}

        {isNameStep && (
          <Box flexDirection="column">
            <Text dimColor>Optional — leave blank for auto-generated name.</Text>
            <TextInput
              key="name"
              prompt="Batch evaluation name"
              initialValue=""
              allowEmpty
              onSubmit={value => {
                setConfig(c => ({ ...c, name: value }));
                goNext();
              }}
              onCancel={() => goBack()}
            />
          </Box>
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Agent', value: config.agent },
              { label: 'Evaluators', value: config.evaluatorNames.join(', ') },
              ...(isDatasetMode
                ? [{ label: 'Source', value: `Dataset: ${dataset ?? 'default'}` }]
                : [
                    { label: 'Lookback', value: `${config.days} day${config.days !== 1 ? 's' : ''}` },
                    {
                      label: 'Sessions',
                      value: `${config.sessionIds.length} selected`,
                    },
                    ...(config.sessionMetadata
                      ? [
                          {
                            label: 'Ground Truth',
                            value: `${config.sessionMetadata.length} session(s) with ground truth`,
                          },
                        ]
                      : []),
                  ]),
              ...(config.kmsKeyArn ? [{ label: 'KMS Key ARN', value: config.kmsKeyArn }] : []),
              ...(config.name ? [{ label: 'Name', value: config.name }] : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

// ============================================================================
// Source Picker
// ============================================================================

interface BatchEvalSourcePickerProps {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
  onSelect: (source: EvalSource, dataset?: string, datasetVersion?: string) => void;
  onExit: () => void;
}

function BatchEvalSourcePicker({
  agents: _agents,
  evaluators: _evaluators,
  onSelect,
  onExit,
}: BatchEvalSourcePickerProps) {
  const [step, setStep] = useState<'source' | 'dataset' | 'version'>('source');
  const [datasets, setDatasets] = useState<{ name: string; schemaType: string }[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<string>('');
  const [versionItems, setVersionItems] = useState<{ id: string; title: string; description: string }[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // Load dataset names from project config
  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const spec = await configIO.readProjectSpec();
        setDatasets(
          (spec.datasets ?? []).map((d: { name: string; schemaType: string }) => ({
            name: d.name,
            schemaType: d.schemaType,
          }))
        );
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
        // If versions can't be loaded (not deployed yet), just offer local
        setVersionItems([{ id: 'local', title: 'Local file', description: 'fastest iteration, no push required' }]);
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

  const SCHEMA_LABELS: Record<string, string> = {
    AGENTCORE_EVALUATION_PREDEFINED_V1: 'Predefined Turns',
    AGENTCORE_EVALUATION_SIMULATED_V1: 'Actor Simulator',
  };

  const datasetItems = datasets.map(d => ({
    id: d.name,
    title: d.name,
    description: SCHEMA_LABELS[d.schemaType] ?? d.schemaType,
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
          handleDatasetSelected(datasets[0]!.name);
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

  // Breadcrumb-only header so the picker shares the wizard's chrome (border + step indicator).
  // 'source' is the active step; the remaining steps are a representative preview (the actual
  // step list is finalized once a mode is chosen and the wizard takes over).
  const pickerSteps: BatchEvalStep[] = ['source', 'evaluators', 'name', 'confirm'];
  const pickerHeader = <StepIndicator steps={pickerSteps} currentStep="source" labels={STEP_LABELS} />;

  if (step === 'version') {
    return (
      <Screen
        title="Run Batch Evaluation"
        onExit={() => (datasets.length > 1 ? setStep('dataset') : setStep('source'))}
        headerContent={pickerHeader}
      >
        <Panel>
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
        </Panel>
      </Screen>
    );
  }

  if (step === 'dataset') {
    return (
      <Screen title="Run Batch Evaluation" onExit={() => setStep('source')} headerContent={pickerHeader}>
        <Panel>
          <Box flexDirection="column">
            <Text bold>Select dataset:</Text>
            {datasetItems.map((item, i) => (
              <Text key={item.id}>
                {i === datasetNav.selectedIndex ? <Text color="cyan">❯ </Text> : '  '}
                <Text color={i === datasetNav.selectedIndex ? 'cyan' : undefined}>{item.title}</Text>
                {item.description && <Text dimColor> — {item.description}</Text>}
              </Text>
            ))}
            <Text dimColor>{'\n'}↑↓ Enter select · Esc back</Text>
          </Box>
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen title="Run Batch Evaluation" onExit={onExit} headerContent={pickerHeader}>
      <Panel>
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
      </Panel>
    </Screen>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
