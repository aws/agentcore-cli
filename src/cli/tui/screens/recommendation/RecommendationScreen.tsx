import { detectRegion } from '../../../aws/region';
import type { SessionInfo } from '../../../operations/eval';
import { discoverSessions } from '../../../operations/eval';
import { loadDeployedProjectConfig, resolveAgent } from '../../../operations/resolve-agent';
import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  GradientText,
  Panel,
  PathInput,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import type { AgentItem, ConfigBundleItem, EvaluatorItem, RecommendationWizardConfig } from './types';
import { DEFAULT_LOOKBACK_DAYS, RECOMMENDATION_STEP_LABELS } from './types';
import { useRecommendationWizard } from './useRecommendationWizard';
import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

interface RecommendationScreenProps {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
  configBundles: ConfigBundleItem[];
  onComplete: (config: RecommendationWizardConfig) => void;
  onExit: () => void;
}

export function RecommendationScreen({
  agents,
  evaluators,
  configBundles,
  onComplete,
  onExit,
}: RecommendationScreenProps) {
  const wizard = useRecommendationWizard();

  // ── Selectable items ──────────────────────────────────────────────────────

  const typeItems: SelectableItem[] = useMemo(
    () => [
      {
        id: 'SYSTEM_PROMPT_RECOMMENDATION',
        title: 'System Prompt',
        description: "Optimize your agent's system prompt based on traces",
      },
      {
        id: 'TOOL_DESCRIPTION_RECOMMENDATION',
        title: 'Tool Description',
        description: 'Optimize tool descriptions for better tool selection',
      },
    ],
    []
  );

  const agentItems: SelectableItem[] = useMemo(
    () =>
      agents.map(a => ({
        id: a.name,
        title: a.name,
        description: `Runtime: ${a.runtimeId}`,
      })),
    [agents]
  );

  const evaluatorItems: SelectableItem[] = useMemo(
    () =>
      evaluators.map(e => ({
        id: e.id,
        title: e.title,
        description: e.description,
      })),
    [evaluators]
  );

  const isToolDesc = wizard.config.type === 'TOOL_DESCRIPTION_RECOMMENDATION';

  const inputSourceItems: SelectableItem[] = useMemo(
    () =>
      isToolDesc
        ? [
            { id: 'inline', title: 'Enter inline', description: 'Type tool name:description pairs directly' },
            {
              id: 'config-bundle',
              title: 'Config bundle',
              description: 'Read tool descriptions from a deployed config bundle',
            },
          ]
        : [
            { id: 'inline', title: 'Enter inline', description: 'Type or paste content directly' },
            { id: 'file', title: 'Load from file', description: 'Read content from a file path' },
            {
              id: 'config-bundle',
              title: 'Config bundle',
              description: 'Use system prompt from a deployed config bundle',
            },
          ],
    [isToolDesc]
  );

  const traceSourceItems: SelectableItem[] = useMemo(
    () => [
      { id: 'cloudwatch', title: 'CloudWatch Logs', description: 'Discover traces from agent runtime logs' },
      { id: 'sessions', title: 'Session IDs', description: 'Provide specific session IDs manually' },
    ],
    []
  );

  // ── Session discovery ──────────────────────────────────────────────────────

  type SessionResult = { phase: 'loaded'; sessions: SessionInfo[] } | { phase: 'error'; message: string };

  const [sessionResult, setSessionResult] = useState<SessionResult & { key: string }>();
  const fetchingRef = useRef('');

  // ── Step flags ────────────────────────────────────────────────────────────

  const isTypeStep = wizard.step === 'type';
  const isAgentStep = wizard.step === 'agent';
  const isEvaluatorStep = wizard.step === 'evaluator';
  const isInputSourceStep = wizard.step === 'inputSource';
  const isContentStep = wizard.step === 'content';
  const isBundleStep = wizard.step === 'bundle';
  const isBundleFieldStep = wizard.step === 'bundleField';
  const isToolsStep = wizard.step === 'tools';
  const isTraceSourceStep = wizard.step === 'traceSource';
  const isDaysStep = wizard.step === 'days';
  const isSessionsStep = wizard.step === 'sessions';
  const isConfirmStep = wizard.step === 'confirm';

  const isSystemPrompt = wizard.config.type === 'SYSTEM_PROMPT_RECOMMENDATION';

  // ── Session discovery effect ──────────────────────────────────────────────

  const fetchKey = `${wizard.config.agent}:${wizard.config.days}`;
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

  // ── Navigation hooks ──────────────────────────────────────────────────────

  const typeNav = useListNavigation({
    items: typeItems,
    onSelect: item => wizard.setType(item.id as 'SYSTEM_PROMPT_RECOMMENDATION' | 'TOOL_DESCRIPTION_RECOMMENDATION'),
    onExit,
    isActive: isTypeStep,
  });

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => wizard.goBack(),
    isActive: isAgentStep,
  });

  const evaluatorNav = useListNavigation({
    items: evaluatorItems,
    onSelect: item => wizard.setEvaluators([item.id]),
    onExit: () => wizard.goBack(),
    isActive: isEvaluatorStep,
  });

  const inputSourceNav = useListNavigation({
    items: inputSourceItems,
    onSelect: item => wizard.setInputSource(item.id as 'inline' | 'file' | 'config-bundle'),
    onExit: () => wizard.goBack(),
    isActive: isInputSourceStep,
  });

  const bundleItems: SelectableItem[] = useMemo(
    () =>
      configBundles.map(cb => ({
        id: cb.bundleArn,
        title: cb.name,
        description: `Version: ${cb.versionId.slice(0, 8)}`,
      })),
    [configBundles]
  );

  const bundleNav = useListNavigation({
    items: bundleItems,
    onSelect: item => {
      const cb = configBundles.find(b => b.bundleArn === item.id);
      if (cb) wizard.setBundle(cb.bundleArn, cb.versionId);
    },
    onExit: () => wizard.goBack(),
    isActive: isBundleStep,
  });

  // Build selectable items from recursively-discovered fields in the selected config bundle
  const selectedBundle = useMemo(
    () => configBundles.find(cb => cb.bundleArn === wizard.config.bundleName),
    [configBundles, wizard.config.bundleName]
  );

  const bundleFieldItems: SelectableItem[] = useMemo(() => {
    if (!selectedBundle) return [];
    return selectedBundle.fields.map(field => {
      // Shorten display: strip the long component ARN key, keep the meaningful tail.
      // "components.arn:aws:...:runtime/name.configuration.systemPrompt" → "configuration.systemPrompt"
      const segments = field.path.split('.');
      const configIdx = segments.indexOf('configuration');
      const displayPath = configIdx >= 0 ? segments.slice(configIdx).join('.') : segments.slice(-2).join('.');
      return {
        id: field.path,
        title: displayPath,
        description: field.value.length > 80 ? field.value.slice(0, 80) + '…' : field.value,
      };
    });
  }, [selectedBundle]);

  // Single-select for: system prompt (always), or tool desc with only 1 field (just press Enter)
  const useFieldSingleSelect = !isToolDesc || bundleFieldItems.length <= 1;
  const bundleFieldNav = useListNavigation({
    items: bundleFieldItems,
    onSelect: item => {
      const field = selectedBundle?.fields.find(f => f.path === item.id);
      if (!field) return;
      wizard.setBundleFields([item.id], { systemPromptJsonPath: field.jsonPath });
    },
    onExit: () => wizard.goBack(),
    isActive: isBundleFieldStep && useFieldSingleSelect,
  });

  // Tool description multi-select: only when there are 2+ fields to choose from
  const bundleFieldMultiNav = useMultiSelectNavigation({
    items: bundleFieldItems,
    getId: item => item.id,
    onConfirm: ids => {
      const toolDescJsonPaths = ids
        .map(id => {
          const field = selectedBundle?.fields.find(f => f.path === id);
          if (!field) return undefined;
          // Use the last segment of the path as the tool name
          const toolName = field.path.split('.').pop()!;
          return { toolName, toolDescriptionJsonPath: field.jsonPath };
        })
        .filter((p): p is { toolName: string; toolDescriptionJsonPath: string } => p !== undefined);
      wizard.setBundleFields(ids, { toolDescJsonPaths });
    },
    onExit: () => wizard.goBack(),
    isActive: isBundleFieldStep && !useFieldSingleSelect,
    requireSelection: true,
  });

  const traceSourceNav = useListNavigation({
    items: traceSourceItems,
    onSelect: item => wizard.setTraceSource(item.id as 'cloudwatch' | 'sessions'),
    onExit: () => wizard.goBack(),
    isActive: isTraceSourceStep,
  });

  // Handle Esc during session loading/error (when multi-select is not yet active)
  useListNavigation({
    items: [{ id: 'back', title: 'Back' }],
    onSelect: () => wizard.goBack(),
    onExit: () => wizard.goBack(),
    isActive: isSessionsStep && sessionPhase !== 'loaded',
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

  // ── Help text ─────────────────────────────────────────────────────────────

  const helpText = isEvaluatorStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isSessionsStep
      ? sessionPhase === 'loading'
        ? ''
        : sessionPhase === 'error'
          ? HELP_TEXT.CONFIRM_CANCEL
          : 'Space toggle · Enter confirm · Esc back'
      : isBundleFieldStep && !useFieldSingleSelect
        ? 'Space to select · Enter confirm · Esc back'
        : isTypeStep || isAgentStep || isInputSourceStep || isTraceSourceStep || isBundleStep || isBundleFieldStep
          ? HELP_TEXT.NAVIGATE_SELECT
          : isConfirmStep
            ? HELP_TEXT.CONFIRM_CANCEL
            : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={RECOMMENDATION_STEP_LABELS} />
  );

  // ── Confirm fields ────────────────────────────────────────────────────────

  const confirmFields = [
    { label: 'Type', value: isSystemPrompt ? 'System Prompt' : 'Tool Description' },
    { label: 'Agent', value: wizard.config.agent },
    ...(isSystemPrompt
      ? [
          {
            label: 'Evaluator',
            value:
              wizard.config.evaluators.map(e => (e.includes('/') ? e.split('/').pop()! : e)).join(', ') || '(none)',
          },
        ]
      : []),
    {
      label: 'Input',
      value:
        wizard.config.inputSource === 'file'
          ? `File: ${wizard.config.content}`
          : wizard.config.inputSource === 'config-bundle'
            ? `Bundle: ${configBundles.find(b => b.bundleArn === wizard.config.bundleName)?.name ?? wizard.config.bundleName} (${wizard.config.bundleFields.length === 1 ? `field: ${wizard.config.bundleFields[0]}` : `fields: ${wizard.config.bundleFields.join(', ')}`})`
            : 'Inline',
    },
    {
      label: 'Traces',
      value:
        wizard.config.traceSource === 'sessions'
          ? `${wizard.config.sessionIds.length} session${wizard.config.sessionIds.length !== 1 ? 's' : ''} selected (auto-fetch)`
          : `CloudWatch (${wizard.config.days}d)`,
    },
  ];

  if (!isSystemPrompt && wizard.config.inputSource !== 'config-bundle') {
    confirmFields.push({ label: 'Tools', value: wizard.config.tools || '(none)' });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Screen
      title="Run Recommendation"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={false}
    >
      <Panel>
        {isTypeStep && (
          <WizardSelect
            title="What do you want to optimize?"
            description="Choose the type of recommendation"
            items={typeItems}
            selectedIndex={typeNav.selectedIndex}
          />
        )}

        {isAgentStep && (
          <WizardSelect
            title="Select agent"
            description="Choose a deployed agent to analyze"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
            emptyMessage="No deployed agents found. Run `agentcore deploy` first."
          />
        )}

        {isEvaluatorStep && (
          <WizardSelect
            title="Select evaluator"
            description="System prompt optimization requires exactly one evaluator"
            items={evaluatorItems}
            selectedIndex={evaluatorNav.selectedIndex}
            emptyMessage="No evaluators available."
            maxVisibleItems={10}
          />
        )}

        {isInputSourceStep && (
          <WizardSelect
            title={
              isSystemPrompt
                ? 'How do you want to provide the system prompt?'
                : 'How do you want to provide tool descriptions?'
            }
            items={inputSourceItems}
            selectedIndex={inputSourceNav.selectedIndex}
          />
        )}

        {isContentStep && wizard.config.inputSource === 'inline' && (
          <TextInput
            key="content-inline"
            prompt={isSystemPrompt ? 'System prompt' : 'Tool descriptions'}
            placeholder={isSystemPrompt ? 'You are a helpful assistant...' : 'toolName:description, ...'}
            onSubmit={wizard.setContent}
            onCancel={() => wizard.goBack()}
            expandable
          />
        )}

        {isContentStep && wizard.config.inputSource === 'file' && (
          <PathInput
            key="content-file"
            onSubmit={wizard.setContent}
            onCancel={() => wizard.goBack()}
            placeholder="/path/to/prompt.txt"
            pathType="file"
          />
        )}

        {isBundleStep && configBundles.length === 0 && (
          <Box flexDirection="column">
            <Text bold>Select config bundle</Text>
            <Text color="yellow">
              No deployed config bundles found. Run `agentcore add config-bundle` and `agentcore deploy` first.
            </Text>
            <Text dimColor>Press Esc to go back and choose a different input source.</Text>
          </Box>
        )}

        {isBundleStep && configBundles.length > 0 && (
          <WizardSelect
            title="Select config bundle"
            description={
              isToolDesc
                ? 'Choose a deployed config bundle to read tool descriptions from'
                : 'Choose a deployed config bundle to read the system prompt from'
            }
            items={bundleItems}
            selectedIndex={bundleNav.selectedIndex}
            maxVisibleItems={10}
          />
        )}

        {isBundleFieldStep && bundleFieldItems.length === 0 && (
          <Box flexDirection="column">
            <Text bold>Select field</Text>
            <Text color="yellow">No text fields found in this config bundle&apos;s configuration.</Text>
            <Text dimColor>Press Esc to go back and choose a different bundle.</Text>
          </Box>
        )}

        {isBundleFieldStep && bundleFieldItems.length > 0 && useFieldSingleSelect && (
          <WizardSelect
            title={
              isToolDesc ? 'Which field contains the tool description?' : 'Which field contains the system prompt?'
            }
            description="Select the field — its JSON path will be sent to the API for server-side resolution"
            items={bundleFieldItems}
            selectedIndex={bundleFieldNav.selectedIndex}
            maxVisibleItems={10}
          />
        )}

        {isBundleFieldStep && bundleFieldItems.length > 0 && !useFieldSingleSelect && (
          <WizardMultiSelect
            title="Which fields contain tool descriptions?"
            description="Select fields — the last path segment becomes the tool name"
            items={bundleFieldItems}
            cursorIndex={bundleFieldMultiNav.cursorIndex}
            selectedIds={bundleFieldMultiNav.selectedIds}
          />
        )}

        {isToolsStep && (
          <Box flexDirection="column">
            <Text dimColor>Enter tool names and descriptions as comma-separated toolName:description pairs.</Text>
            <TextInput
              key="tools"
              prompt="Tools"
              placeholder="search:Find documents, calculator:Compute math"
              onSubmit={wizard.setTools}
              onCancel={() => wizard.goBack()}
              expandable
            />
          </Box>
        )}

        {isTraceSourceStep && (
          <WizardSelect
            title="How do you want to source agent traces?"
            items={traceSourceItems}
            selectedIndex={traceSourceNav.selectedIndex}
          />
        )}

        {isDaysStep && (
          <Box flexDirection="column">
            <Text dimColor>Note: Traces may take 5-10 min to appear after agent invocations.</Text>
            <TextInput
              key="days"
              prompt="Lookback window (days)"
              initialValue={String(DEFAULT_LOOKBACK_DAYS)}
              onSubmit={value => {
                const days = parseInt(value, 10);
                if (!isNaN(days) && days >= 1 && days <= 90) {
                  wizard.setDays(days);
                }
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
          <WizardMultiSelect
            title="Select sessions to analyze"
            description={`Found ${sessionItems.length} session${sessionItems.length !== 1 ? 's' : ''} — select one or more`}
            items={sessionItems}
            cursorIndex={sessionsNav.cursorIndex}
            selectedIds={sessionsNav.selectedIds}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
