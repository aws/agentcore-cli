/**
 * Version history screen — shows versions grouped by branch for a single bundle.
 * Enter views version details, D starts diff selection.
 */
import { getConfigurationBundleVersion } from '../../../../cli/aws/agentcore-config-bundles';
import type { ConfigurationBundleVersionSummary } from '../../../../cli/aws/agentcore-config-bundles';
import { Panel, Screen } from '../../components';
import type { BundleWithMeta } from './useConfigBundleHub';
import { useVersionHistory } from './useConfigBundleHub';
import { Box, Text, useInput } from 'ink';
import React, { useMemo, useState } from 'react';

function formatTimestamp(epochSeconds: string): string {
  const num = Number(epochSeconds);
  const ms = num < 1e12 ? num * 1000 : num;
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

interface VersionHistoryScreenProps {
  bundle: BundleWithMeta;
  region: string;
  onViewDiff: (bundleId: string, fromVersionId: string, toVersionId: string) => void;
  onExit: () => void;
}

type Mode = 'browse' | 'diff-select-from' | 'diff-select-to' | 'version-detail';

export function VersionHistoryScreen({ bundle, region, onViewDiff, onExit }: VersionHistoryScreenProps) {
  const { versions, isLoading, error } = useVersionHistory(bundle.bundleId, region);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('browse');
  const [diffFromId, setDiffFromId] = useState<string | undefined>();
  const [detailText, setDetailText] = useState<string | undefined>();

  // Flat list of all versions for navigation
  const flatVersions = useMemo(() => versions, [versions]);

  // Group by branch for display
  const byBranch = useMemo(() => {
    const map = new Map<string, ConfigurationBundleVersionSummary[]>();
    for (const v of versions) {
      const branch = v.lineageMetadata?.branchName ?? 'unknown';
      if (!map.has(branch)) map.set(branch, []);
      map.get(branch)!.push(v);
    }
    return map;
  }, [versions]);

  useInput(
    (input, key) => {
      if (isLoading || flatVersions.length === 0) return;

      if (mode === 'version-detail') {
        if (key.escape) setMode('browse');
        return;
      }

      // Navigation
      if (key.upArrow) {
        setSelectedIndex(i => (i - 1 + flatVersions.length) % flatVersions.length);
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(i => (i + 1) % flatVersions.length);
        return;
      }

      if (mode === 'browse') {
        // Enter — view version detail
        if (key.return && flatVersions[selectedIndex]) {
          setMode('version-detail');
          setDetailText(undefined);
          void loadDetail(flatVersions[selectedIndex].versionId);
          return;
        }
        // D — start diff
        if (input === 'd' || input === 'D') {
          setMode('diff-select-from');
          return;
        }
      }

      if (mode === 'diff-select-from') {
        if (key.escape) {
          setMode('browse');
          return;
        }
        if (key.return && flatVersions[selectedIndex]) {
          setDiffFromId(flatVersions[selectedIndex].versionId);
          setMode('diff-select-to');
          return;
        }
      }

      if (mode === 'diff-select-to') {
        if (key.escape) {
          setMode('diff-select-from');
          return;
        }
        if (key.return && flatVersions[selectedIndex] && diffFromId) {
          onViewDiff(bundle.bundleId, diffFromId, flatVersions[selectedIndex].versionId);
          return;
        }
      }
    },
    { isActive: !isLoading }
  );

  async function loadDetail(versionId: string) {
    try {
      const detail = await getConfigurationBundleVersion({
        region,
        bundleId: bundle.bundleId,
        versionId,
      });
      const lines: string[] = [];
      lines.push(`Version: ${detail.versionId}`);
      if (detail.description) lines.push(`Description: ${detail.description}`);
      if (detail.lineageMetadata?.branchName) lines.push(`Branch: ${detail.lineageMetadata.branchName}`);
      if (detail.lineageMetadata?.commitMessage) lines.push(`Message: ${detail.lineageMetadata.commitMessage}`);
      if (detail.lineageMetadata?.createdBy) {
        const cb = detail.lineageMetadata.createdBy;
        lines.push(`Created by: ${cb.name}${cb.arn ? ` (${cb.arn})` : ''}`);
      }
      if (detail.lineageMetadata?.parentVersionIds?.length) {
        lines.push(`Parent: ${detail.lineageMetadata.parentVersionIds.map(id => id).join(', ')}`);
      }
      lines.push(`Created: ${formatTimestamp(detail.versionCreatedAt)}`);
      lines.push('');
      lines.push('Components:');
      for (const [arn, comp] of Object.entries(detail.components)) {
        lines.push(`  ${arn}`);
        lines.push(`  ${JSON.stringify(comp.configuration, null, 2).split('\n').join('\n  ')}`);
        lines.push('');
      }
      setDetailText(lines.join('\n'));
    } catch (err) {
      setDetailText(`Error loading version: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (isLoading) {
    return (
      <Screen title={`${bundle.bundleName} — Versions`} onExit={onExit} exitEnabled={mode === 'browse'}>
        <Text dimColor>Loading version history...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title={`${bundle.bundleName} — Versions`} onExit={onExit}>
        <Text color="red">Error: {error}</Text>
      </Screen>
    );
  }

  // Version detail overlay
  if (mode === 'version-detail') {
    return (
      <Screen title={`${bundle.bundleName} — Version Detail`} onExit={() => setMode('browse')} helpText="Esc back">
        <Panel fullWidth>{detailText ? <Text>{detailText}</Text> : <Text dimColor>Loading...</Text>}</Panel>
      </Screen>
    );
  }

  // Mode-specific help text
  let helpText = '↑↓ navigate · Enter view · D diff · Esc back · Ctrl+C quit';
  if (mode === 'diff-select-from') {
    helpText = '↑↓ navigate · Enter select FROM version · Esc cancel';
  } else if (mode === 'diff-select-to') {
    helpText = `↑↓ navigate · Enter select TO version · Esc back (from: ${diffFromId!})`;
  }

  // Mode-specific header
  let modeIndicator: React.ReactNode = null;
  if (mode === 'diff-select-from') {
    modeIndicator = (
      <Box marginBottom={1}>
        <Text color="yellow">Select the FROM version for diff:</Text>
      </Box>
    );
  } else if (mode === 'diff-select-to') {
    modeIndicator = (
      <Box marginBottom={1}>
        <Text color="yellow">From: {diffFromId!} — Now select the TO version:</Text>
      </Box>
    );
  }

  // Build a flat index map so we can highlight the selected version
  let flatIdx = 0;

  return (
    <Screen
      title={`${bundle.bundleName} — Versions`}
      onExit={onExit}
      helpText={helpText}
      exitEnabled={mode === 'browse'}
    >
      <Panel fullWidth>
        {modeIndicator}
        {[...byBranch.entries()].map(([branch, branchVersions]) => (
          <Box key={branch} flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              Branch: {branch}
            </Text>
            {branchVersions.map((v, i) => {
              const currentFlatIdx = flatIdx++;
              const isSelected = currentFlatIdx === selectedIndex;
              const meta = v.lineageMetadata;
              const message = meta?.commitMessage ?? '';
              const isLast = i === branchVersions.length - 1;
              const connector = isLast ? '└' : '├';
              const isDiffFrom = v.versionId === diffFromId;

              return (
                <Box key={v.versionId} flexDirection="column">
                  <Text>
                    <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '❯' : ' '} </Text>
                    <Text>{connector} </Text>
                    <Text color="green" bold={isDiffFrom}>
                      {v.versionId}
                    </Text>
                    <Text dimColor> {formatTimestamp(v.versionCreatedAt)}</Text>
                    {message ? <Text> &quot;{message}&quot;</Text> : null}
                  </Text>
                  {meta?.parentVersionIds?.length ? (
                    <Text>
                      {'  '}
                      {isLast ? ' ' : '│'} <Text dimColor>parent: {meta.parentVersionIds.join(', ')}</Text>
                    </Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ))}
      </Panel>
    </Screen>
  );
}
