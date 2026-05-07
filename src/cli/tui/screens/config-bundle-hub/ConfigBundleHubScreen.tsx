/**
 * Top-level config bundle hub — lists all deployed bundles.
 * Enter drills into version history.
 */
import { Panel, Screen } from '../../components';
import type { BundleWithMeta } from './useConfigBundleHub';
import { useConfigBundleHub } from './useConfigBundleHub';
import { Box, Text, useInput } from 'ink';
import React from 'react';

function formatRelativeTime(epochSeconds: string): string {
  const ms = Number(epochSeconds) < 1e12 ? Number(epochSeconds) * 1000 : Number(epochSeconds);
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ConfigBundleHubScreenProps {
  onSelectBundle: (bundle: BundleWithMeta, region: string) => void;
  onExit: () => void;
}

export function ConfigBundleHubScreen({ onSelectBundle, onExit }: ConfigBundleHubScreenProps) {
  const { bundles, isLoading, error, region } = useConfigBundleHub();
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  useInput(
    (input: string, key: { return: boolean; upArrow: boolean; downArrow: boolean }) => {
      if (key.upArrow && bundles.length > 0) {
        setSelectedIndex(i => (i - 1 + bundles.length) % bundles.length);
      }
      if (key.downArrow && bundles.length > 0) {
        setSelectedIndex(i => (i + 1) % bundles.length);
      }
      if (key.return && bundles[selectedIndex]) {
        onSelectBundle(bundles[selectedIndex], region);
      }
    },
    { isActive: !isLoading && bundles.length > 0 }
  );

  if (isLoading) {
    return (
      <Screen title="Configuration Bundles [preview]" onExit={onExit}>
        <Text dimColor>Loading configuration bundles...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title="Configuration Bundles [preview]" onExit={onExit}>
        <Text color="red">Error: {error}</Text>
      </Screen>
    );
  }

  if (bundles.length === 0) {
    return (
      <Screen title="Configuration Bundles [preview]" onExit={onExit}>
        <Panel>
          <Text dimColor>No configuration bundles found.</Text>
          <Text dimColor>Use `agentcore add config-bundle` to create one, then deploy.</Text>
        </Panel>
      </Screen>
    );
  }

  const headerContent = (
    <Box>
      <Text>Region: </Text>
      <Text color="yellow">{region}</Text>
      <Text dimColor> · {bundles.length} bundle(s)</Text>
    </Box>
  );

  return (
    <Screen
      title="Configuration Bundles [preview]"
      onExit={onExit}
      helpText="↑↓ navigate · Enter view versions · Esc back · Ctrl+C quit"
      headerContent={headerContent}
    >
      <Panel fullWidth>
        {bundles.map((bundle, idx) => (
          <BundleRow key={bundle.bundleId} bundle={bundle} selected={idx === selectedIndex} />
        ))}
      </Panel>
    </Screen>
  );
}

function BundleRow({ bundle, selected }: { bundle: BundleWithMeta; selected: boolean }) {
  const branchSummary = bundle.branches.length > 0 ? bundle.branches.join(', ') : 'no branches';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
        <Text bold color={selected ? 'cyan' : undefined}>
          {bundle.bundleName}
        </Text>
      </Text>
      <Text>
        {'  '}
        <Text dimColor>
          Versions: {bundle.versionCount} ({branchSummary})
        </Text>
      </Text>
      {bundle.description && (
        <Text>
          {'  '}
          <Text dimColor>Description: {bundle.description}</Text>
        </Text>
      )}
      {bundle.lastUpdated && (
        <Text>
          {'  '}
          <Text dimColor>Last update: {formatRelativeTime(bundle.lastUpdated)}</Text>
        </Text>
      )}
    </Box>
  );
}
