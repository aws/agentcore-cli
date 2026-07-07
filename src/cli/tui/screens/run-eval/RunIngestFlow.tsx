import { ConfigIO } from '../../../../lib';
import { getErrorMessage } from '../../../errors';
import { runKbIngestionByName } from '../../../operations/ingest';
import type { StartedIngestion } from '../../../operations/ingest';
import { ConfirmReview, ErrorPrompt, GradientText, Panel, Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const SCREEN_TITLE = 'Ingest Knowledge Base';

interface KnowledgeBaseInfo {
  name: string;
}

interface DeployedDataSource {
  dataSourceId: string;
  uri: string;
}

interface DeployedKb {
  knowledgeBaseId: string;
  dataSources: DeployedDataSource[];
}

interface FlowContext {
  /** All knowledge bases declared in agentcore.json */
  knowledgeBases: KnowledgeBaseInfo[];
  /** AWS deployment target names */
  targetNames: string[];
  /** Region per target name */
  regionByTarget: Record<string, string>;
  /** Deployed-state lookup: targetName -> kbName -> deployed kb */
  deployedKbsByTarget: Record<string, Record<string, DeployedKb>>;
  /** Raw deployed-state — passed straight back into runKbIngestionByName */
  deployedState: Parameters<typeof runKbIngestionByName>[0]['deployedState'];
}

type FlowState =
  | { name: 'loading' }
  | { name: 'select-kb'; ctx: FlowContext }
  | { name: 'select-target'; ctx: FlowContext; kbName: string }
  | { name: 'select-scope'; ctx: FlowContext; kbName: string; targetName: string; deployed: DeployedKb }
  | {
      name: 'select-data-source';
      ctx: FlowContext;
      kbName: string;
      targetName: string;
      deployed: DeployedKb;
    }
  | {
      name: 'confirm';
      ctx: FlowContext;
      kbName: string;
      targetName: string;
      deployed: DeployedKb;
      dataSourceUri?: string;
    }
  | {
      name: 'running';
      ctx: FlowContext;
      kbName: string;
      targetName: string;
      deployed: DeployedKb;
      dataSourceUri?: string;
      progress: string[];
    }
  | { name: 'success'; kbName: string; startedJobs: StartedIngestion[] }
  | { name: 'error'; message: string; ctx?: FlowContext };

interface RunIngestFlowProps {
  onExit: () => void;
}

export function RunIngestFlow({ onExit }: RunIngestFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (flow.name !== 'loading') return;
    let cancelled = false;

    void (async () => {
      try {
        const configIO = new ConfigIO();
        const [project, awsTargets, deployedState] = await Promise.all([
          configIO.readProjectSpec(),
          configIO.readAWSDeploymentTargets(),
          configIO.readDeployedState().catch(() => ({ targets: {} })),
        ]);

        if (cancelled) return;

        const knowledgeBases: KnowledgeBaseInfo[] = (project.knowledgeBases ?? []).map(kb => ({ name: kb.name }));

        if (knowledgeBases.length === 0) {
          setFlow({
            name: 'error',
            message: 'No knowledge bases found in agentcore.json. Run `agentcore add knowledge-base` first.',
          });
          return;
        }

        const targetNames = awsTargets.map(t => t.name);
        const regionByTarget: Record<string, string> = {};
        for (const t of awsTargets) regionByTarget[t.name] = t.region;

        if (targetNames.length === 0) {
          setFlow({
            name: 'error',
            message: 'No AWS deployment targets found in aws-targets.json.',
          });
          return;
        }

        const deployedKbsByTarget: Record<string, Record<string, DeployedKb>> = {};
        for (const [tname, target] of Object.entries(deployedState.targets ?? {})) {
          const kbs = target?.resources?.knowledgeBases ?? {};
          const map: Record<string, DeployedKb> = {};
          for (const [kbName, kb] of Object.entries(kbs)) {
            map[kbName] = {
              knowledgeBaseId: kb.knowledgeBaseId,
              dataSources: (kb.dataSources ?? []).map(ds => ({ dataSourceId: ds.dataSourceId, uri: ds.uri })),
            };
          }
          deployedKbsByTarget[tname] = map;
        }

        setFlow({
          name: 'select-kb',
          ctx: {
            knowledgeBases,
            targetNames,
            regionByTarget,
            deployedKbsByTarget,
            deployedState,
          },
        });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  // ── Run ingestion when entering 'running' ────────────────────────────────
  useEffect(() => {
    if (flow.name !== 'running') return;
    let cancelled = false;

    const { ctx, kbName, targetName, dataSourceUri } = flow;
    const region = ctx.regionByTarget[targetName];

    void (async () => {
      if (!region) {
        if (cancelled) return;
        setFlow({ name: 'error', message: `Region for target '${targetName}' could not be resolved.`, ctx });
        return;
      }
      try {
        const result = await runKbIngestionByName({
          knowledgeBaseName: kbName,
          deployedState: ctx.deployedState,
          targetName,
          region,
          dataSourceUri,
          onProgress: msg => {
            if (cancelled) return;
            setFlow(prev => (prev.name === 'running' ? { ...prev, progress: [...prev.progress, msg] } : prev));
          },
        });

        if (cancelled) return;

        if (!result.success) {
          setFlow({ name: 'error', message: result.error.message, ctx });
          return;
        }
        setFlow({ name: 'success', kbName, startedJobs: result.startedJobs });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err), ctx });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Renders ──────────────────────────────────────────────────────────────
  if (flow.name === 'loading') {
    return (
      <Screen title={SCREEN_TITLE} onExit={onExit}>
        <GradientText text="Loading project state..." />
      </Screen>
    );
  }

  if (flow.name === 'error') {
    return (
      <ErrorPrompt
        message="Knowledge base ingestion failed"
        detail={flow.message}
        onBack={() => (flow.ctx ? setFlow({ name: 'select-kb', ctx: flow.ctx }) : onExit())}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'select-kb') {
    return (
      <SelectKbStep
        ctx={flow.ctx}
        onSelect={kbName => {
          const ctx = flow.ctx;
          // Auto-skip target picker when only one target is configured
          if (ctx.targetNames.length === 1) {
            const targetName = ctx.targetNames[0]!;
            return advanceAfterTarget(setFlow, ctx, kbName, targetName);
          }
          setFlow({ name: 'select-target', ctx, kbName });
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'select-target') {
    return (
      <SelectTargetStep
        ctx={flow.ctx}
        kbName={flow.kbName}
        onSelect={targetName => advanceAfterTarget(setFlow, flow.ctx, flow.kbName, targetName)}
        onBack={() => setFlow({ name: 'select-kb', ctx: flow.ctx })}
      />
    );
  }

  if (flow.name === 'select-scope') {
    return (
      <SelectScopeStep
        ctx={flow.ctx}
        kbName={flow.kbName}
        targetName={flow.targetName}
        deployed={flow.deployed}
        onAll={() =>
          setFlow({
            name: 'confirm',
            ctx: flow.ctx,
            kbName: flow.kbName,
            targetName: flow.targetName,
            deployed: flow.deployed,
          })
        }
        onChooseOne={() =>
          setFlow({
            name: 'select-data-source',
            ctx: flow.ctx,
            kbName: flow.kbName,
            targetName: flow.targetName,
            deployed: flow.deployed,
          })
        }
        onBack={() => {
          if (flow.ctx.targetNames.length > 1) {
            setFlow({ name: 'select-target', ctx: flow.ctx, kbName: flow.kbName });
          } else {
            setFlow({ name: 'select-kb', ctx: flow.ctx });
          }
        }}
      />
    );
  }

  if (flow.name === 'select-data-source') {
    return (
      <SelectDataSourceStep
        deployed={flow.deployed}
        kbName={flow.kbName}
        onSelect={uri =>
          setFlow({
            name: 'confirm',
            ctx: flow.ctx,
            kbName: flow.kbName,
            targetName: flow.targetName,
            deployed: flow.deployed,
            dataSourceUri: uri,
          })
        }
        onBack={() =>
          setFlow({
            name: 'select-scope',
            ctx: flow.ctx,
            kbName: flow.kbName,
            targetName: flow.targetName,
            deployed: flow.deployed,
          })
        }
      />
    );
  }

  if (flow.name === 'confirm') {
    return (
      <ConfirmStep
        kbName={flow.kbName}
        targetName={flow.targetName}
        dataSourceUri={flow.dataSourceUri}
        deployed={flow.deployed}
        onConfirm={() =>
          setFlow({
            name: 'running',
            ctx: flow.ctx,
            kbName: flow.kbName,
            targetName: flow.targetName,
            deployed: flow.deployed,
            dataSourceUri: flow.dataSourceUri,
            progress: [],
          })
        }
        onBack={() => {
          if (flow.dataSourceUri !== undefined) {
            setFlow({
              name: 'select-data-source',
              ctx: flow.ctx,
              kbName: flow.kbName,
              targetName: flow.targetName,
              deployed: flow.deployed,
            });
          } else {
            setFlow({
              name: 'select-scope',
              ctx: flow.ctx,
              kbName: flow.kbName,
              targetName: flow.targetName,
              deployed: flow.deployed,
            });
          }
        }}
      />
    );
  }

  if (flow.name === 'running') {
    return (
      <Screen title={SCREEN_TITLE} onExit={onExit}>
        <Panel>
          <Box flexDirection="column" gap={1}>
            <GradientText text="Starting ingestion..." />
            {flow.progress.length > 0 && (
              <Box flexDirection="column">
                {flow.progress.map((line, i) => (
                  <Text key={i} dimColor>
                    {line}
                  </Text>
                ))}
              </Box>
            )}
            <Text dimColor>Bedrock allows one ingestion job per KB at a time. Sit tight while jobs start.</Text>
          </Box>
        </Panel>
      </Screen>
    );
  }

  // success
  return <SuccessView kbName={flow.kbName} startedJobs={flow.startedJobs} onExit={onExit} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function advanceAfterTarget(
  setFlow: React.Dispatch<React.SetStateAction<FlowState>>,
  ctx: FlowContext,
  kbName: string,
  targetName: string
) {
  const deployed = ctx.deployedKbsByTarget[targetName]?.[kbName];
  if (!deployed) {
    setFlow({
      name: 'error',
      ctx,
      message: `Knowledge base '${kbName}' has not been deployed to target '${targetName}'. Run \`agentcore deploy\` first.`,
    });
    return;
  }
  if (deployed.dataSources.length === 0) {
    setFlow({
      name: 'error',
      ctx,
      message: `Knowledge base '${kbName}' has no recorded data sources. Run \`agentcore deploy\` first.`,
    });
    return;
  }
  setFlow({ name: 'select-scope', ctx, kbName, targetName, deployed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step components
// ─────────────────────────────────────────────────────────────────────────────

interface SelectKbStepProps {
  ctx: FlowContext;
  onSelect: (kbName: string) => void;
  onExit: () => void;
}

function SelectKbStep({ ctx, onSelect, onExit }: SelectKbStepProps) {
  const items: SelectableItem[] = useMemo(
    () =>
      ctx.knowledgeBases.map(kb => {
        // Show whether KB is deployed to *any* target as a hint
        const anyDeployed = Object.values(ctx.deployedKbsByTarget).some(map => kb.name in map);
        return {
          id: kb.name,
          title: kb.name,
          description: anyDeployed ? 'deployed' : 'not yet deployed',
        };
      }),
    [ctx]
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id),
    onExit,
    isActive: true,
  });

  return (
    <Screen title={SCREEN_TITLE} onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT}>
      <Panel>
        <WizardSelect
          title="Select knowledge base"
          description="Choose a knowledge base from your project."
          items={items}
          selectedIndex={nav.selectedIndex}
        />
      </Panel>
    </Screen>
  );
}

interface SelectTargetStepProps {
  ctx: FlowContext;
  kbName: string;
  onSelect: (targetName: string) => void;
  onBack: () => void;
}

function SelectTargetStep({ ctx, kbName, onSelect, onBack }: SelectTargetStepProps) {
  const items: SelectableItem[] = useMemo(
    () =>
      ctx.targetNames.map(name => ({
        id: name,
        title: name,
        description: ctx.regionByTarget[name] ?? '',
      })),
    [ctx]
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id),
    onExit: onBack,
    isActive: true,
  });

  return (
    <Screen title={SCREEN_TITLE} onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
      <Panel>
        <WizardSelect
          title={`Select deployment target for '${kbName}'`}
          description="Each target maps to an AWS account/region in aws-targets.json."
          items={items}
          selectedIndex={nav.selectedIndex}
        />
      </Panel>
    </Screen>
  );
}

interface SelectScopeStepProps {
  ctx: FlowContext;
  kbName: string;
  targetName: string;
  deployed: DeployedKb;
  onAll: () => void;
  onChooseOne: () => void;
  onBack: () => void;
}

function SelectScopeStep({ kbName, deployed, onAll, onChooseOne, onBack }: SelectScopeStepProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'all',
        title: 'All data sources',
        description: `Start ingestion for all ${deployed.dataSources.length} data source(s) on this KB.`,
      },
      {
        id: 'one',
        title: 'Choose one data source',
        description: 'Pick a single data source to ingest.',
      },
    ],
    [deployed.dataSources.length]
  );

  const nav = useListNavigation({
    items,
    onSelect: item => {
      if (item.id === 'all') onAll();
      else onChooseOne();
    },
    onExit: onBack,
    isActive: true,
  });

  return (
    <Screen title={SCREEN_TITLE} onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
      <Panel>
        <WizardSelect
          title={`Ingestion scope for '${kbName}'`}
          description="Choose whether to ingest every data source or just one."
          items={items}
          selectedIndex={nav.selectedIndex}
        />
      </Panel>
    </Screen>
  );
}

interface SelectDataSourceStepProps {
  deployed: DeployedKb;
  kbName: string;
  onSelect: (uri: string) => void;
  onBack: () => void;
}

function SelectDataSourceStep({ deployed, kbName, onSelect, onBack }: SelectDataSourceStepProps) {
  const items: SelectableItem[] = useMemo(
    () =>
      deployed.dataSources.map(ds => ({
        id: ds.uri,
        title: ds.uri,
        description: ds.dataSourceId,
      })),
    [deployed]
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id),
    onExit: onBack,
    isActive: true,
  });

  return (
    <Screen title={SCREEN_TITLE} onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
      <Panel>
        <WizardSelect
          title={`Select data source for '${kbName}'`}
          description="Only this data source will be re-ingested."
          items={items}
          selectedIndex={nav.selectedIndex}
        />
      </Panel>
    </Screen>
  );
}

interface ConfirmStepProps {
  kbName: string;
  targetName: string;
  deployed: DeployedKb;
  dataSourceUri?: string;
  onConfirm: () => void;
  onBack: () => void;
}

function ConfirmStep({ kbName, targetName, deployed, dataSourceUri, onConfirm, onBack }: ConfirmStepProps) {
  // Single-button confirm — Enter to start, Esc back
  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: onConfirm,
    onExit: onBack,
    isActive: true,
  });

  const scope = dataSourceUri
    ? `Single data source — ${dataSourceUri}`
    : `All data sources (${deployed.dataSources.length})`;

  return (
    <Screen title={SCREEN_TITLE} onExit={onBack} helpText={HELP_TEXT.CONFIRM_CANCEL}>
      <Panel>
        <ConfirmReview
          title="Review ingestion"
          fields={[
            { label: 'Knowledge base', value: kbName },
            { label: 'Target', value: targetName },
            { label: 'Knowledge base ID', value: deployed.knowledgeBaseId },
            { label: 'Scope', value: scope },
          ]}
        />
      </Panel>
    </Screen>
  );
}

interface SuccessViewProps {
  kbName: string;
  startedJobs: StartedIngestion[];
  onExit: () => void;
}

function SuccessView({ kbName, startedJobs, onExit }: SuccessViewProps) {
  const actions = useMemo(() => [{ id: 'back', title: 'Back to Run menu' }], []);
  const nav = useListNavigation({
    items: actions,
    onSelect: useCallback(() => onExit(), [onExit]),
    onExit,
    isActive: true,
  });

  return (
    <Screen title={SCREEN_TITLE} onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <Panel fullWidth>
        <Box flexDirection="column" gap={1}>
          <Text color="green">
            ✓ Started ingestion for &apos;{kbName}&apos; ({startedJobs.length} job(s))
          </Text>
          <Box flexDirection="column">
            {startedJobs.map(job => (
              <Text key={job.dataSourceId}>
                {'  '}
                <Text dimColor>{job.uri}</Text>
                <Text> → </Text>
                <Text>{job.ingestionJobId}</Text>
              </Text>
            ))}
          </Box>
          <Text dimColor>Run `agentcore status --type knowledge-base --name {kbName}` to track progress.</Text>
          <Box flexDirection="column">
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
