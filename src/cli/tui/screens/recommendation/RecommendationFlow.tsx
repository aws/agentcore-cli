import { ConfigIO } from '../../../../lib';
import type { DeployedState } from '../../../../schema';
import { validateAwsCredentials } from '../../../aws/account';
import { listEvaluators } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { RecommendationJobRecord } from '../../../operations/jobs';
import { ErrorPrompt, GradientText, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { RecommendationScreen } from './RecommendationScreen';
import type {
  AgentItem,
  ConfigBundleField,
  ConfigBundleItem,
  EvaluatorItem,
  RecommendationWizardConfig,
} from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; agents: AgentItem[]; evaluators: EvaluatorItem[]; configBundles: ConfigBundleItem[] }
  | { name: 'starting'; config: RecommendationWizardConfig }
  | { name: 'started'; record: RecommendationJobRecord; config: RecommendationWizardConfig }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string; logFilePath?: string };

interface RecommendationFlowProps {
  onExit: () => void;
  /** Navigate to the Recommendation Jobs screen (falls back to onExit when not provided). */
  onViewJobs?: () => void;
}

export function RecommendationFlow({ onExit, onViewJobs }: RecommendationFlowProps) {
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
        const configIO = new ConfigIO();
        const [{ region }, deployedState] = await Promise.all([detectRegion(), configIO.readDeployedState()]);

        if (cancelled) return;

        const agents = buildAgentItems(deployedState);
        if (agents.length === 0) {
          setFlow({
            name: 'error',
            message: 'No deployed agents found. Run `agentcore deploy` first.',
          });
          return;
        }

        const evalResult = await listEvaluators({ region });
        if (cancelled) return;

        const evaluators: EvaluatorItem[] = evalResult.evaluators.map(e => ({
          id: e.evaluatorArn || e.evaluatorName,
          title: e.evaluatorName,
          description: e.description ?? e.evaluatorType,
        }));

        const projectSpec = await configIO.readProjectSpec();
        const configBundles = buildConfigBundleItems(deployedState, projectSpec.configBundles ?? []);

        setFlow({ name: 'wizard', agents, evaluators, configBundles });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  const handleRunComplete = useCallback((config: RecommendationWizardConfig) => {
    setFlow({ name: 'starting', config });
  }, []);

  // Fire-and-forget: start the recommendation job, then show the Started confirmation screen.
  useEffect(() => {
    if (flow.name !== 'starting') return;
    let cancelled = false;

    const { config } = flow;

    void (async () => {
      try {
        const result = await engine.start('recommendation', {
          type: config.type,
          agent: config.agent,
          evaluators: config.evaluators,
          inputSource: config.inputSource,
          inlineContent: config.inputSource === 'inline' ? config.content : undefined,
          promptFile: config.inputSource === 'file' ? config.content : undefined,
          bundleName: config.inputSource === 'config-bundle' ? config.bundleName : undefined,
          bundleVersion: config.inputSource === 'config-bundle' ? config.bundleVersion : undefined,
          systemPromptJsonPath:
            config.inputSource === 'config-bundle' && config.systemPromptJsonPath
              ? config.systemPromptJsonPath
              : undefined,
          toolDescJsonPaths:
            config.inputSource === 'config-bundle' && config.toolDescJsonPaths.length > 0
              ? config.toolDescJsonPaths
              : undefined,
          tools: config.tools
            ? config.tools
                .split(/,(?=[a-zA-Z0-9_\-.]+:)/)
                .map(t => t.trim())
                .filter(Boolean)
            : undefined,
          traceSource: config.traceSource,
          lookbackDays: config.days,
          sessionIds: config.sessionIds.length > 0 ? config.sessionIds : undefined,
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

  // ── Render states ─────────────────────────────────────────────────────────

  if (flow.name === 'loading') {
    return (
      <Screen title="Run Recommendation" onExit={onExit}>
        <GradientText text="Loading agents and evaluators..." />
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'wizard') {
    return (
      <RecommendationScreen
        agents={flow.agents}
        evaluators={flow.evaluators}
        configBundles={flow.configBundles}
        onComplete={handleRunComplete}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'starting') {
    return (
      <Screen title="Run Recommendation" onExit={onExit}>
        <GradientText text="Starting recommendation..." />
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
      message="Recommendation failed"
      detail={flow.logFilePath ? `${flow.message}\n\nLog: ${flow.logFilePath}` : flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Started confirmation view
// ─────────────────────────────────────────────────────────────────────────────

interface StartedViewProps {
  record: RecommendationJobRecord;
  config: RecommendationWizardConfig;
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
    <Screen title="Recommendation Started" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="green">✓ Recommendation submitted</Text>
          <Text>
            <Text bold>ID:</Text> {record.id}
            {'  '}
            <Text bold>Status:</Text> {record.status}
          </Text>
          <Text>
            <Text bold>Agent:</Text> {config.agent}
          </Text>

          <Box marginTop={1}>
            <Text dimColor>
              When it completes, view it in Recommendation Jobs — the new config bundle (if any) will be applied to
              agentcore.json automatically.
            </Text>
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildAgentItems(deployedState: DeployedState): AgentItem[] {
  const agents: AgentItem[] = [];
  const seen = new Set<string>();

  for (const target of Object.values(deployedState.targets)) {
    const runtimeMap = target.resources?.runtimes;
    if (!runtimeMap) continue;
    for (const [name, state] of Object.entries(runtimeMap)) {
      if (seen.has(name)) continue;
      seen.add(name);
      agents.push({ name, runtimeId: state.runtimeId, runtimeArn: state.runtimeArn });
    }
  }

  return agents;
}

/**
 * Recursively collect all string-valued leaf fields from an object.
 * Returns entries with their full dot-notation path and JSONPath equivalent.
 *
 * The recommendation API resolves JSONPath against the components map directly,
 * using dot notation: `$.{componentArn}.configuration.{fieldName}`
 */
function collectStringFields(obj: unknown, prefix: string, jsonPathPrefix: string): ConfigBundleField[] {
  const fields: ConfigBundleField[] = [];
  if (obj === null || obj === undefined || typeof obj !== 'object') return fields;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const jp = jsonPathPrefix ? `${jsonPathPrefix}.${key}` : key;
    if (typeof value === 'string' && value.trim().length > 0) {
      fields.push({ path, jsonPath: jp, value });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      fields.push(...collectStringFields(value, path, jp));
    }
  }

  return fields;
}

function buildConfigBundleItems(
  deployedState: DeployedState,
  projectBundles: { name: string; components?: Record<string, { configuration?: Record<string, unknown> }> }[]
): ConfigBundleItem[] {
  const bundles: ConfigBundleItem[] = [];
  const seen = new Set<string>();

  for (const target of Object.values(deployedState.targets)) {
    const bundleMap = target.resources?.configBundles;
    if (!bundleMap) continue;
    for (const [name, state] of Object.entries(bundleMap)) {
      if (seen.has(name)) continue;
      seen.add(name);

      const projBundle = projectBundles.find(pb => pb.name === name);
      const fields = projBundle?.components ? collectStringFields(projBundle.components, '', '$') : [];

      bundles.push({
        name,
        bundleId: state.bundleId,
        bundleArn: state.bundleArn,
        versionId: state.versionId,
        fields,
      });
    }
  }

  return bundles;
}
