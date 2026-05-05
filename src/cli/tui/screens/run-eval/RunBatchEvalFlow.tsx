import { validateAwsCredentials } from '../../../aws/account';
import { stopBatchEvaluation } from '../../../aws/agentcore-batch-evaluation';
import type { SessionMetadataEntry } from '../../../aws/agentcore-batch-evaluation';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import type { SessionInfo } from '../../../operations/eval';
import { discoverSessions } from '../../../operations/eval';
import { saveBatchEvalRun } from '../../../operations/eval/batch-eval-storage';
import { runBatchEvaluationCommand } from '../../../operations/eval/run-batch-evaluation';
import type {
  BatchEvaluationResult,
  RunBatchEvaluationCommandResult,
} from '../../../operations/eval/run-batch-evaluation';
import { loadDeployedProjectConfig, resolveAgent } from '../../../operations/resolve-agent';
import {
  ConfirmReview,
  ErrorPrompt,
  GradientText,
  Panel,
  PathInput,
  Screen,
  StepIndicator,
  StepProgress,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem, Step } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import type { EvaluatorItem } from '../online-eval/types';
import { GroundTruthForm } from './GroundTruthForm';
import type { AgentItem } from './types';
import type { GroundTruthData } from './useRunEvalWizard';
import { Box, Text, useInput } from 'ink';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

const DEFAULT_LOOKBACK_DAYS = 7;

type BatchEvalStep = 'agent' | 'evaluators' | 'days' | 'sessions' | 'ground-truth' | 'name' | 'confirm';

interface BatchEvalConfig {
  agent: string;
  evaluators: string[];
  evaluatorNames: string[];
  days: number;
  sessionIds: string[];
  groundTruthFile: string;
  sessionMetadata?: SessionMetadataEntry[];
  name: string;
}

const STEP_LABELS: Record<BatchEvalStep, string> = {
  agent: 'Agent',
  evaluators: 'Evaluators',
  days: 'Lookback',
  sessions: 'Sessions',
  'ground-truth': 'Ground Truth',
  name: 'Name',
  confirm: 'Confirm',
};

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; agents: AgentItem[]; evaluators: EvaluatorItem[] }
  | {
      name: 'running';
      config: BatchEvalConfig;
      steps: Step[];
      elapsed: number;
      batchEvaluationId?: string;
      region?: string;
    }
  | { name: 'results'; result: RunBatchEvaluationCommandResult; savedFilePath?: string }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string; logFilePath?: string };

// ============================================================================
// Flow Component
// ============================================================================

interface RunBatchEvalFlowProps {
  onExit: () => void;
}

export function RunBatchEvalFlow({ onExit }: RunBatchEvalFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const stoppingRef = useRef(false);

  // Handle Esc to stop a running batch evaluation
  useInput((_input, key) => {
    if (flow.name !== 'running' || !flow.batchEvaluationId || !flow.region || stoppingRef.current) return;
    if (key.escape) {
      stoppingRef.current = true;
      void stopBatchEvaluation({ region: flow.region, batchEvaluationId: flow.batchEvaluationId }).catch(() => {
        // Best-effort — the poll loop will pick up the final status
      });
      setFlow(prev => {
        if (prev.name !== 'running') return prev;
        const steps = prev.steps.map(s =>
          s.status === 'running' ? { ...s, status: 'error' as const, error: 'Stopping...' } : s
        );
        return { ...prev, steps };
      });
    }
  });

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

        setFlow({ name: 'wizard', agents, evaluators });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  const handleWizardComplete = useCallback((config: BatchEvalConfig) => {
    stoppingRef.current = false;
    const initialSteps: Step[] = [
      { label: 'Starting batch evaluation...', status: 'running' },
      { label: 'Polling for results', status: 'pending' },
      { label: 'Fetching scores', status: 'pending' },
    ];
    setFlow({ name: 'running', config, steps: initialSteps, elapsed: 0 });
  }, []);

  // Execute batch evaluation
  useEffect(() => {
    if (flow.name !== 'running') return;
    let cancelled = false;

    const { config } = flow;
    const startTime = Date.now();

    const timer = setInterval(() => {
      if (!cancelled) {
        setFlow(prev => {
          if (prev.name !== 'running') return prev;
          return { ...prev, elapsed: Math.floor((Date.now() - startTime) / 1000) };
        });
      }
    }, 1000);

    void (async () => {
      try {
        const result = await runBatchEvaluationCommand({
          agent: config.agent,
          evaluators: config.evaluators,
          name: config.name || undefined,
          sessionIds: config.sessionIds.length > 0 ? config.sessionIds : undefined,
          lookbackDays: config.days,
          sessionMetadata: config.sessionMetadata,
          onProgress: (status, _message) => {
            if (cancelled) return;
            setFlow(prev => {
              if (prev.name !== 'running') return prev;
              const steps = [...prev.steps];
              if (status === 'running') {
                steps[0] = { ...steps[0]!, status: 'success' };
                steps[1] = { ...steps[1]!, status: 'running' };
              }
              return { ...prev, steps };
            });
          },
          onStarted: info => {
            setFlow(prev => {
              if (prev.name !== 'running') return prev;
              return { ...prev, batchEvaluationId: info.batchEvaluationId, region: info.region };
            });
          },
        });

        clearInterval(timer);
        if (cancelled) return;

        // Save results locally
        let savedFilePath: string | undefined;
        if (result.success) {
          try {
            savedFilePath = saveBatchEvalRun(result);
          } catch {
            // Non-fatal
          }
        }

        if (!result.success) {
          setFlow(prev => {
            if (prev.name !== 'running') return prev;
            const steps = prev.steps.map(s =>
              s.status === 'running' ? { ...s, status: 'error' as const, error: result.error.message } : s
            );
            return { ...prev, steps };
          });
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (cancelled) return;
          setFlow({
            name: 'error',
            message: result.error?.message ?? 'Batch evaluation failed',
            logFilePath: result.logFilePath,
          });
          return;
        }

        // Mark all steps success
        setFlow(prev => {
          if (prev.name !== 'running') return prev;
          const steps = prev.steps.map(s => ({ ...s, status: 'success' as const }));
          return { ...prev, steps };
        });

        setFlow({ name: 'results', result, savedFilePath });
      } catch (err) {
        clearInterval(timer);
        if (!cancelled) {
          const errorMsg = getErrorMessage(err);
          setFlow(prev => {
            if (prev.name !== 'running') return prev;
            const steps = prev.steps.map(s =>
              s.status === 'running' ? { ...s, status: 'error' as const, error: errorMsg } : s
            );
            return { ...prev, steps };
          });
          await new Promise(resolve => setTimeout(resolve, 2000));
          setFlow({ name: 'error', message: errorMsg });
        }
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [flow.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flow.name === 'loading') {
    return (
      <Screen title="Run Batch Evaluation [preview]" onExit={onExit}>
        <GradientText text="Loading agents and evaluators..." />
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'wizard') {
    return (
      <BatchEvalWizard
        agents={flow.agents}
        evaluators={flow.evaluators}
        onComplete={handleWizardComplete}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'running') {
    const minutes = Math.floor(flow.elapsed / 60);
    const seconds = flow.elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    return (
      <Screen title="Run Batch Evaluation [preview]" onExit={onExit}>
        <Panel>
          <Box flexDirection="column" gap={1}>
            <Text>
              <Text bold>Agent:</Text> {flow.config.agent}
              {'  '}
              <Text bold>Evaluators:</Text> {flow.config.evaluatorNames.join(', ')}
              {'  '}
              <Text dimColor>({timeStr})</Text>
            </Text>
            <StepProgress steps={flow.steps} />
            <Text dimColor>This may take a few minutes...</Text>
            {flow.batchEvaluationId && <Text dimColor>Press Esc to stop the evaluation</Text>}
          </Box>
        </Panel>
      </Screen>
    );
  }

  if (flow.name === 'results') {
    return (
      <ResultsView
        result={flow.result}
        savedFilePath={flow.savedFilePath}
        onRunAnother={() => setFlow({ name: 'loading' })}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Batch evaluation failed"
      detail={flow.logFilePath ? `${flow.message}\n\nLog: ${flow.logFilePath}` : flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

// ============================================================================
// Wizard Component
// ============================================================================

interface BatchEvalWizardProps {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
  onComplete: (config: BatchEvalConfig) => void;
  onExit: () => void;
}

function BatchEvalWizard({ agents, evaluators: rawEvaluators, onComplete, onExit }: BatchEvalWizardProps) {
  const skipAgent = agents.length <= 1;
  const allSteps = useMemo<BatchEvalStep[]>(
    () =>
      skipAgent
        ? ['evaluators', 'days', 'sessions', 'ground-truth', 'name', 'confirm']
        : ['agent', 'evaluators', 'days', 'sessions', 'ground-truth', 'name', 'confirm'],
    [skipAgent]
  );

  const [step, setStep] = useState<BatchEvalStep>(allSteps[0]!);
  const [config, setConfig] = useState<BatchEvalConfig>({
    agent: skipAgent ? agents[0]!.name : '',
    evaluators: [],
    evaluatorNames: [],
    days: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
    groundTruthFile: '',
    sessionMetadata: undefined,
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

  const headerContent = <StepIndicator steps={allSteps} currentStep={step} labels={STEP_LABELS} />;

  return (
    <Screen title="Run Batch Evaluation [preview]" onExit={goBack} helpText={helpText} headerContent={headerContent}>
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
              { label: 'Lookback', value: `${config.days} day${config.days !== 1 ? 's' : ''}` },
              {
                label: 'Sessions',
                value: `${config.sessionIds.length} selected`,
              },
              ...(config.sessionMetadata
                ? [{ label: 'Ground Truth', value: `${config.sessionMetadata.length} session(s) with ground truth` }]
                : []),
              ...(config.name ? [{ label: 'Name', value: config.name }] : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

// ============================================================================
// Results View
// ============================================================================

function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

interface ResultsViewProps {
  result: RunBatchEvaluationCommandResult;
  savedFilePath?: string;
  onRunAnother: () => void;
  onExit: () => void;
}

function ResultsView({ result, savedFilePath, onRunAnother, onExit }: ResultsViewProps) {
  const actions = [
    { id: 'another', title: 'Run another batch evaluation' },
    { id: 'back', title: 'Back' },
  ];

  const nav = useListNavigation({
    items: actions,
    onSelect: item => {
      if (item.id === 'another') onRunAnother();
      else onExit();
    },
    onExit,
    isActive: true,
  });

  const evalRes = result.evaluationResults;
  const summaries = evalRes?.evaluatorSummaries;

  // Fall back to local grouping when API summaries aren't available
  const byEvaluator = useMemo(() => {
    if (summaries && summaries.length > 0) return null;
    const map = new Map<string, BatchEvaluationResult[]>();
    for (const r of result.results) {
      const group = map.get(r.evaluatorId) ?? [];
      group.push(r);
      map.set(r.evaluatorId, group);
    }
    return map;
  }, [result.results, summaries]);

  return (
    <Screen
      title="Batch Evaluation Complete [preview]"
      onExit={onExit}
      helpText={HELP_TEXT.NAVIGATE_SELECT}
      exitEnabled={false}
    >
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="green">✓ Batch evaluation complete</Text>
          <Text>
            <Text bold>ID:</Text> {result.batchEvaluationId}
            {'  '}
            <Text bold>Status:</Text> {result.status}
          </Text>
          {result.name && (
            <Text>
              <Text bold>Name:</Text> {result.name}
            </Text>
          )}

          {evalRes?.totalNumberOfSessions != null && (
            <Text>
              <Text bold>Sessions:</Text> {evalRes.totalNumberOfSessions} total
              {evalRes.numberOfSessionsCompleted != null && (
                <Text>, {evalRes.numberOfSessionsCompleted} completed</Text>
              )}
              {evalRes.numberOfSessionsFailed ? (
                <Text color="red">, {evalRes.numberOfSessionsFailed} failed</Text>
              ) : null}
            </Text>
          )}

          {summaries && summaries.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Scores range from 0 (worst) to 1 (best).</Text>
              {summaries.map(s => {
                const avg = s.statistics?.averageScore;
                const avgStr = avg != null ? avg.toFixed(2) : 'N/A';
                const color = avg != null ? scoreColor(avg) : undefined;
                return (
                  <Text key={s.evaluatorId}>
                    {'  '}
                    <Text bold>{s.evaluatorId}</Text>
                    {'  '}
                    <Text color={color}>{avgStr}</Text>
                    {s.totalFailed ? <Text color="red"> ({s.totalFailed} failed)</Text> : null}
                    {s.totalEvaluated != null && <Text dimColor> [{s.totalEvaluated} evaluated]</Text>}
                  </Text>
                );
              })}
            </Box>
          ) : byEvaluator && byEvaluator.size > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Scores range from 0 (worst) to 1 (best).</Text>
              {[...byEvaluator.entries()].map(([evalId, evalResults]) => {
                const scores = evalResults.filter(r => !r.error).map(r => r.score!);
                const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
                const errors = evalResults.filter(r => r.error).length;
                return (
                  <Text key={evalId}>
                    {'  '}
                    <Text bold>{evalId}</Text>
                    {'  '}
                    <Text color={scoreColor(avg)}>{avg.toFixed(2)}</Text>
                    {errors > 0 && <Text color="red"> ({errors} errors)</Text>}
                  </Text>
                );
              })}
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>No evaluation results returned.</Text>
            </Box>
          )}

          {savedFilePath && (
            <Box marginTop={1}>
              <Text dimColor>Results saved to: {savedFilePath}</Text>
            </Box>
          )}
          {result.logFilePath && (
            <Box marginTop={1}>
              <Text dimColor>Log: {result.logFilePath}</Text>
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
