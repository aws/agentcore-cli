/**
 * Dataset Flow — manages navigation between hub, download, publish-version, and remove-version screens.
 */
import { ConfigIO } from '../../../../lib';
import type { Dataset } from '../../../../schema';
import { listDatasetVersions } from '../../../aws/agentcore-datasets';
import type { DatasetVersionSummary } from '../../../aws/agentcore-datasets';
import { deleteDatasetVersion, publishDataset, pullDataset } from '../../../operations/dataset';
import type { PullResult } from '../../../operations/dataset';
import { ErrorPrompt, Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { useListNavigation } from '../../hooks';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

interface ResolvedDatasetInfo {
  name: string;
  datasetId: string;
  region: string;
  location: string;
}

type FlowState =
  | { name: 'loading' }
  | { name: 'hub'; datasets: ResolvedDatasetInfo[] }
  | { name: 'pick-dataset'; action: 'download' | 'publish-version' | 'remove-version'; datasets: ResolvedDatasetInfo[] }
  | { name: 'pick-version'; dataset: ResolvedDatasetInfo; versions: DatasetVersionSummary[] }
  | { name: 'pick-delete-version'; dataset: ResolvedDatasetInfo; versions: DatasetVersionSummary[] }
  | { name: 'confirm-pull'; dataset: ResolvedDatasetInfo; version: string }
  | { name: 'confirm-delete'; dataset: ResolvedDatasetInfo; version: string }
  | { name: 'running'; message: string }
  | { name: 'pull-result'; dataset: ResolvedDatasetInfo; result: PullResult }
  | { name: 'publish-result'; dataset: ResolvedDatasetInfo; version: string; exampleCount: number }
  | { name: 'delete-result'; dataset: ResolvedDatasetInfo; version: string }
  | { name: 'error'; message: string };

const HUB_ACTIONS: SelectableItem[] = [
  { id: 'download', title: 'Download', description: 'Download service DRAFT/version → local file' },
  { id: 'publish-version', title: 'Publish Version', description: 'Snapshot DRAFT → immutable version' },
  { id: 'remove-version', title: 'Remove Version', description: 'Delete a specific published version' },
];

// ============================================================================
// Component
// ============================================================================

interface DatasetFlowProps {
  onExit: () => void;
}

export function DatasetFlow({ onExit }: DatasetFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // Load datasets on mount
  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const projectSpec = await configIO.readProjectSpec();
        const datasets: Dataset[] = projectSpec.datasets ?? [];

        if (datasets.length === 0) {
          setFlow({ name: 'error', message: 'No datasets found. Run `agentcore add dataset` first.' });
          return;
        }

        const targets = await configIO.resolveAWSDeploymentTargets();
        if (targets.length === 0) {
          setFlow({
            name: 'error',
            message: 'No AWS deployment targets configured. Run `agentcore deploy` first to create one.',
          });
          return;
        }
        const region = targets[0]!.region;
        const targetName = targets[0]!.name;

        const deployedState = await configIO.readDeployedState().catch(() => undefined);
        const deployedDatasets = deployedState?.targets?.[targetName]?.resources?.datasets ?? {};

        const resolved: ResolvedDatasetInfo[] = [];
        for (const ds of datasets) {
          const state = deployedDatasets[ds.name];
          if (state) {
            resolved.push({
              name: ds.name,
              datasetId: state.datasetId,
              region,
              location: ds.config.managed.location,
            });
          }
        }

        if (resolved.length === 0) {
          setFlow({ name: 'error', message: 'No deployed datasets found. Run `agentcore deploy` first.' });
          return;
        }

        setFlow({ name: 'hub', datasets: resolved });
      } catch (err) {
        setFlow({ name: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  const executeAction = async (action: string, dataset: ResolvedDatasetInfo, version?: string) => {
    const configIO = new ConfigIO();
    const configBaseDir = configIO.getConfigRoot();

    setFlow({ name: 'running', message: `Running ${action}...` });

    try {
      if (action === 'download') {
        if (!version) {
          const versions = await listDatasetVersions({ region: dataset.region, datasetId: dataset.datasetId });
          setFlow({ name: 'pick-version', dataset, versions: versions.versions });
          return;
        }
        const result = await pullDataset({
          region: dataset.region,
          datasetId: dataset.datasetId,
          localFilePath: dataset.location,
          configBaseDir,
          version: version === 'DRAFT' ? undefined : version,
        });
        setFlow({ name: 'pull-result', dataset, result });
      } else if (action === 'publish-version') {
        const result = await publishDataset({
          region: dataset.region,
          datasetId: dataset.datasetId,
        });
        setFlow({ name: 'publish-result', dataset, version: result.version, exampleCount: result.exampleCount });
      } else if (action === 'remove-version') {
        if (!version) {
          const versions = await listDatasetVersions({ region: dataset.region, datasetId: dataset.datasetId });
          setFlow({ name: 'pick-delete-version', dataset, versions: versions.versions });
          return;
        }
        setFlow({ name: 'confirm-delete', dataset, version });
      } else if (action === 'confirm-delete') {
        await deleteDatasetVersion({
          region: dataset.region,
          datasetId: dataset.datasetId,
          version: version!,
        });
        setFlow({ name: 'delete-result', dataset, version: version! });
      }
    } catch (err) {
      setFlow({ name: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleAction = useCallback((actionId: string, datasets: ResolvedDatasetInfo[]) => {
    const action = actionId as 'download' | 'publish-version' | 'remove-version';
    if (datasets.length === 1) {
      void executeAction(action, datasets[0]!);
    } else {
      setFlow({ name: 'pick-dataset', action, datasets });
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════════════
  // Render states
  // ══════════════════════════════════════════════════════════════════════════

  if (flow.name === 'loading') {
    return (
      <Screen title="Dataset Management" onExit={onExit}>
        <Text dimColor>Loading datasets...</Text>
      </Screen>
    );
  }

  if (flow.name === 'hub') {
    return <HubScreen datasets={flow.datasets} onSelect={handleAction} onExit={onExit} />;
  }

  if (flow.name === 'pick-dataset') {
    return (
      <DatasetPickerScreen
        datasets={flow.datasets}
        onSelect={dataset => void executeAction(flow.action, dataset)}
        onExit={() => setFlow({ name: 'hub', datasets: flow.datasets })}
      />
    );
  }

  if (flow.name === 'pick-version') {
    return (
      <VersionPickerScreen
        versions={flow.versions}
        onSelect={version => setFlow({ name: 'confirm-pull', dataset: flow.dataset, version })}
        onExit={() => setFlow({ name: 'hub', datasets: [] })}
      />
    );
  }

  if (flow.name === 'confirm-pull') {
    const versionLabel = flow.version === 'DRAFT' ? 'DRAFT' : `version ${flow.version}`;
    return (
      <ConfirmPullScreen
        location={flow.dataset.location}
        versionLabel={versionLabel}
        onConfirm={() => void executeAction('download', flow.dataset, flow.version)}
        onCancel={() => setFlow({ name: 'hub', datasets: [] })}
      />
    );
  }

  if (flow.name === 'running') {
    return (
      <Screen title="Dataset Management" onExit={onExit}>
        <Text dimColor>{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.name === 'pick-delete-version') {
    return (
      <DeleteVersionPickerScreen
        versions={flow.versions}
        onSelect={version => setFlow({ name: 'confirm-delete', dataset: flow.dataset, version })}
        onExit={() => setFlow({ name: 'hub', datasets: [] })}
      />
    );
  }

  if (flow.name === 'confirm-delete') {
    return (
      <ConfirmDeleteScreen
        datasetName={flow.dataset.name}
        version={flow.version}
        onConfirm={() => void executeAction('confirm-delete', flow.dataset, flow.version)}
        onCancel={() => setFlow({ name: 'hub', datasets: [] })}
      />
    );
  }

  if (flow.name === 'delete-result') {
    return (
      <Screen title="Dataset Management" onExit={onExit}>
        <Box flexDirection="column">
          <Text color="green">
            ✓ Deleted version {flow.version} of dataset &quot;{flow.dataset.name}&quot;
          </Text>
        </Box>
      </Screen>
    );
  }

  if (flow.name === 'pull-result') {
    return (
      <Screen title="Dataset Management" onExit={onExit}>
        <Box flexDirection="column">
          <Text color="green">
            ✓ {flow.result.exampleCount} examples written to {flow.dataset.location}
          </Text>
          <Text dimColor>
            {' '}
            Pulled from: {flow.result.version === 'DRAFT' ? 'DRAFT' : `version ${flow.result.version}`}
          </Text>
        </Box>
      </Screen>
    );
  }

  if (flow.name === 'publish-result') {
    return (
      <Screen title="Dataset Management" onExit={onExit}>
        <Box flexDirection="column">
          <Text color="green">
            ✓ Published version {flow.version} ({flow.exampleCount} examples)
          </Text>
          <Text dimColor> draftStatus: UNMODIFIED</Text>
        </Box>
      </Screen>
    );
  }

  return <ErrorPrompt message="Dataset error" detail={flow.message} onBack={onExit} onExit={onExit} />;
}

// ============================================================================
// Sub-screens
// ============================================================================

function HubScreen({
  datasets,
  onSelect,
  onExit,
}: {
  datasets: ResolvedDatasetInfo[];
  onSelect: (actionId: string, datasets: ResolvedDatasetInfo[]) => void;
  onExit: () => void;
}) {
  const nav = useListNavigation({
    items: HUB_ACTIONS,
    onSelect: (item: SelectableItem) => onSelect(item.id, datasets),
  });

  return (
    <Screen title="Dataset Management" onExit={onExit}>
      <WizardSelect
        title="What would you like to do?"
        description={`${datasets.length} dataset(s) deployed`}
        items={HUB_ACTIONS}
        selectedIndex={nav.selectedIndex}
      />
    </Screen>
  );
}

function DatasetPickerScreen({
  datasets,
  onSelect,
  onExit,
}: {
  datasets: ResolvedDatasetInfo[];
  onSelect: (dataset: ResolvedDatasetInfo) => void;
  onExit: () => void;
}) {
  const items: SelectableItem[] = datasets.map(d => ({
    id: d.name,
    title: d.name,
    description: d.datasetId,
  }));

  const nav = useListNavigation({
    items,
    onSelect: (item: SelectableItem) => {
      const dataset = datasets.find(d => d.name === item.id)!;
      onSelect(dataset);
    },
  });

  return (
    <Screen title="Select Dataset" onExit={onExit}>
      <WizardSelect title="Which dataset?" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}

function VersionPickerScreen({
  versions,
  onSelect,
  onExit,
}: {
  versions: DatasetVersionSummary[];
  onSelect: (version: string) => void;
  onExit: () => void;
}) {
  const items: SelectableItem[] = [
    { id: 'DRAFT', title: 'DRAFT', description: 'Current working copy' },
    ...versions.map((v, i) => ({
      id: v.datasetVersion,
      title: `Version ${v.datasetVersion}${i === 0 ? ' (latest)' : ''}`,
      description: `${v.exampleCount} examples`,
    })),
  ];

  const nav = useListNavigation({
    items,
    onSelect: (item: SelectableItem) => onSelect(item.id),
  });

  return (
    <Screen title="Pull From" onExit={onExit}>
      <WizardSelect title="Which version to pull?" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}

function ConfirmPullScreen({
  location,
  versionLabel,
  onConfirm,
  onCancel,
}: {
  location: string;
  versionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const items: SelectableItem[] = [
    { id: 'yes', title: 'Yes, overwrite', description: '' },
    { id: 'no', title: 'Cancel', description: '' },
  ];

  const nav = useListNavigation({
    items,
    onSelect: (item: SelectableItem) => {
      if (item.id === 'yes') onConfirm();
      else onCancel();
    },
  });

  return (
    <Screen title="Confirm Pull" onExit={onCancel}>
      <Box flexDirection="column">
        <Text color="yellow">⚠ This will overwrite: {location}</Text>
        <Text dimColor> (pulling {versionLabel})</Text>
        <Text>{''}</Text>
        <WizardSelect title="Continue?" items={items} selectedIndex={nav.selectedIndex} />
      </Box>
    </Screen>
  );
}

function DeleteVersionPickerScreen({
  versions,
  onSelect,
  onExit,
}: {
  versions: DatasetVersionSummary[];
  onSelect: (version: string) => void;
  onExit: () => void;
}) {
  const items: SelectableItem[] = versions.map((v, i) => ({
    id: v.datasetVersion,
    title: `Version ${v.datasetVersion}${i === 0 ? ' (latest)' : ''}`,
    description: `${v.exampleCount} examples`,
  }));

  const nav = useListNavigation({
    items,
    onSelect: (item: SelectableItem) => onSelect(item.id),
  });

  return (
    <Screen title="Delete Version" onExit={onExit}>
      <WizardSelect title="Which version to delete?" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}

function ConfirmDeleteScreen({
  datasetName,
  version,
  onConfirm,
  onCancel,
}: {
  datasetName: string;
  version: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const items: SelectableItem[] = [
    { id: 'yes', title: 'Yes, delete', description: '' },
    { id: 'no', title: 'Cancel', description: '' },
  ];

  const nav = useListNavigation({
    items,
    onSelect: (item: SelectableItem) => {
      if (item.id === 'yes') onConfirm();
      else onCancel();
    },
  });

  return (
    <Screen title="Confirm Delete" onExit={onCancel}>
      <Box flexDirection="column">
        <Text color="yellow">
          ⚠ This will permanently delete version {version} of dataset &quot;{datasetName}&quot;
        </Text>
        <Text>{''}</Text>
        <WizardSelect title="Continue?" items={items} selectedIndex={nav.selectedIndex} />
      </Box>
    </Screen>
  );
}
