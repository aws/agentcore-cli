import { detectRegion } from '../../../aws/region';
import type { SessionInfo } from '../../../operations/eval';
import { discoverSessions } from '../../../operations/eval';
import { loadDeployedProjectConfig, resolveAgent } from '../../../operations/resolve-agent';
import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  GradientText,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import type { EvaluatorItem } from '../online-eval/types';
import { GroundTruthForm } from './GroundTruthForm';
import type { AgentItem, RunEvalConfig } from './types';
import { DEFAULT_LOOKBACK_DAYS, RUN_EVAL_STEP_LABELS } from './types';
import { useRunEvalWizard } from './useRunEvalWizard';
import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

interface RunEvalScreenProps {
  agents: AgentItem[];
  evaluatorItems: EvaluatorItem[];
  onComplete: (config: RunEvalConfig) => void;
  onExit: () => void;
}

export function RunEvalScreen({ agents, evaluatorItems: rawEvaluatorItems, onComplete, onExit }: RunEvalScreenProps) {
  const wizard = useRunEvalWizard(agents.length);

  // Auto-select agent if only one
  const singleAgent = agents.length === 1 ? agents[0]!.name : null;
  if (singleAgent && !wizard.config.agent) {
    wizard.setAgent(singleAgent);
  }

  const agentItems: SelectableItem[] = useMemo(
    () => agents.map(a => ({ id: a.name, title: a.name, description: a.build })),
    [agents]
  );

  const evaluatorItems: SelectableItem[] = useMemo(
    () =>
      rawEvaluatorItems.map(e => ({
        id: e.arn,
        title: e.name,
        description: e.type === 'Builtin' ? 'Built-in evaluator' : (e.description ?? 'Custom evaluator'),
      })),
    [rawEvaluatorItems]
  );

  // Session discovery — result keyed by agent+days so we refetch when config changes
  type SessionResult = { phase: 'loaded'; sessions: SessionInfo[] } | { phase: 'error'; message: string };

  const [sessionResult, setSessionResult] = useState<SessionResult & { key: string }>();
  const fetchingRef = useRef('');

  const isAgentStep = wizard.step === 'agent';
  const isEvaluatorsStep = wizard.step === 'evaluators';
  const isDaysStep = wizard.step === 'days';
  const isSessionsStep = wizard.step === 'sessions';
  const isGroundTruthStep = wizard.step === 'groundTruth';
  const isConfirmStep = wizard.step === 'confirm';

  const fetchKey = `${wizard.config.agent}:${wizard.config.days}`;
  const sessionPhase = !isSessionsStep ? 'idle' : sessionResult?.key === fetchKey ? sessionResult.phase : 'loading';

  // Discover sessions when entering the sessions step
  useEffect(() => {
    if (!isSessionsStep) return;
    if (sessionResult?.key === fetchKey) return;
    if (fetchingRef.current === fetchKey) return;
    fetchingRef.current = fetchKey;
    let cancelled = false;

    void (async () => {
      try {
        const context = await loadDeployedProjectConfig();
        const { region } = await detectRegion();
        const agentResult = resolveAgent(context, { runtime: wizard.config.agent });
        if (!agentResult.success) {
          if (!cancelled) setSessionResult({ key: fetchKey, phase: 'error', message: agentResult.error });
          return;
        }

        const sessions = await discoverSessions({
          runtimeId: agentResult.agent.runtimeId,
          region,
          lookbackDays: wizard.config.days,
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

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit,
    isActive: isAgentStep,
  });

  const evaluatorsNav = useMultiSelectNavigation({
    items: evaluatorItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setEvaluators(ids),
    onExit: () => (agents.length <= 1 ? onExit() : wizard.goBack()),
    isActive: isEvaluatorsStep,
    requireSelection: true,
  });

  const sessionsNav = useMultiSelectNavigation({
    items: sessionItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setSessions(ids),
    onExit: () => wizard.goBack(),
    isActive: isSessionsStep && sessionPhase === 'loaded',
    requireSelection: true,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isAgentStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isEvaluatorsStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isSessionsStep
        ? sessionPhase === 'loading'
          ? ''
          : sessionPhase === 'error'
            ? HELP_TEXT.CONFIRM_CANCEL
            : 'Space toggle · Enter confirm · Esc back'
        : isGroundTruthStep
          ? 'Enter add · Enter (empty) next · Enter submit · Esc back'
          : isConfirmStep
            ? HELP_TEXT.CONFIRM_CANCEL
            : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={RUN_EVAL_STEP_LABELS} />;

  // Build confirm fields
  const confirmFields = [
    { label: 'Agent', value: wizard.config.agent },
    { label: 'Evaluators', value: wizard.config.evaluators.join(', ') },
    { label: 'Lookback', value: `${wizard.config.days} day${wizard.config.days !== 1 ? 's' : ''}` },
    {
      label: 'Sessions',
      value: `${wizard.config.sessionIds.length} selected`,
    },
    ...(wizard.config.assertions.length > 0
      ? [{ label: 'Assertions', value: `${wizard.config.assertions.length} assertion(s)` }]
      : []),
    ...(wizard.config.expectedResponse
      ? [
          {
            label: 'Exp. Response',
            value:
              wizard.config.expectedResponse.length > 40
                ? wizard.config.expectedResponse.slice(0, 40) + '...'
                : wizard.config.expectedResponse,
          },
        ]
      : []),
    ...(wizard.config.expectedTrajectory.length > 0
      ? [{ label: 'Exp. Trajectory', value: wizard.config.expectedTrajectory.join(', ') }]
      : []),
  ];

  return (
    <Screen
      title="Run On-demand Evaluation"
      onExit={onExit}
      exitEnabled={isAgentStep || isEvaluatorsStep}
      helpText={helpText}
      headerContent={headerContent}
    >
      <Panel>
        {isAgentStep && (
          <WizardSelect
            title="Select agent to evaluate"
            description="Choose a project agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isEvaluatorsStep && (
          <WizardMultiSelect
            title="Select evaluators"
            description="Choose evaluators to run against agent traces"
            items={evaluatorItems}
            cursorIndex={evaluatorsNav.cursorIndex}
            selectedIds={evaluatorsNav.selectedIds}
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
                if (isNaN(days) || days < 1 || days > 90) return;
                wizard.setDays(days);
              }}
              onCancel={() => wizard.goBack()}
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
          <Box flexDirection="column">
            <WizardMultiSelect
              title="Select sessions to evaluate"
              description={`Found ${sessionItems.length} session${sessionItems.length !== 1 ? 's' : ''} — select one or more`}
              items={sessionItems}
              cursorIndex={sessionsNav.cursorIndex}
              selectedIds={sessionsNav.selectedIds}
            />
            <Text dimColor>Select exactly 1 session to provide ground truth.</Text>
          </Box>
        )}

        {isGroundTruthStep && (
          <GroundTruthForm
            sessionId={wizard.config.sessionIds[0]!}
            onSubmit={wizard.setGroundTruth}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
