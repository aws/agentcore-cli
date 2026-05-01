/**
 * Diff screen — shows component differences between two bundle versions.
 */
import { getConfigurationBundleVersion } from '../../../../cli/aws/agentcore-config-bundles';
import type { GetConfigurationBundleVersionResult } from '../../../../cli/aws/agentcore-config-bundles';
import { deepDiff } from '../../../../cli/operations/config-bundle/diff-versions';
import type { DiffEntry } from '../../../../cli/operations/config-bundle/diff-versions';
import { Panel, Screen } from '../../components';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

function formatTimestamp(epochSeconds: string): string {
  const num = Number(epochSeconds);
  const ms = num < 1e12 ? num * 1000 : num;
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

interface DiffScreenProps {
  bundleId: string;
  bundleName: string;
  fromVersionId: string;
  toVersionId: string;
  region: string;
  onExit: () => void;
}

export function DiffScreen({ bundleId, bundleName, fromVersionId, toVersionId, region, onExit }: DiffScreenProps) {
  const [fromVersion, setFromVersion] = useState<GetConfigurationBundleVersionResult | undefined>();
  const [toVersion, setToVersion] = useState<GetConfigurationBundleVersionResult | undefined>();
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();

  useEffect(() => {
    async function load() {
      try {
        const [from, to] = await Promise.all([
          getConfigurationBundleVersion({ region, bundleId, versionId: fromVersionId }),
          getConfigurationBundleVersion({ region, bundleId, versionId: toVersionId }),
        ]);
        setFromVersion(from);
        setToVersion(to);
        setDiffs(deepDiff(from.components, to.components));
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    }
    void load();
  }, [bundleId, fromVersionId, toVersionId, region]);

  // Build display lines
  const lines = useMemo(() => {
    if (!fromVersion || !toVersion) return [];
    const result: { text: string; color?: string }[] = [];

    result.push({
      text: `Diff: ${fromVersion.versionId} → ${toVersion.versionId}`,
    });
    result.push({
      text: `From: ${fromVersion.lineageMetadata?.commitMessage ?? '(no message)'} (${formatTimestamp(fromVersion.versionCreatedAt)})`,
      color: 'gray',
    });
    result.push({
      text: `To: ${toVersion.lineageMetadata?.commitMessage ?? '(no message)'} (${formatTimestamp(toVersion.versionCreatedAt)})`,
      color: 'gray',
    });
    result.push({ text: '' });

    if (diffs.length === 0) {
      result.push({ text: 'No differences found.', color: 'green' });
    } else {
      result.push({ text: `${diffs.length} change(s):` });
      result.push({ text: '' });

      for (const d of diffs) {
        result.push({ text: d.path });
        if (d.type === 'added') {
          result.push({ text: `+ ${JSON.stringify(d.newValue)}`, color: 'green' });
        } else if (d.type === 'removed') {
          result.push({ text: `- ${JSON.stringify(d.oldValue)}`, color: 'red' });
        } else if (d.type === 'changed') {
          result.push({ text: `- ${JSON.stringify(d.oldValue)}`, color: 'red' });
          result.push({ text: `+ ${JSON.stringify(d.newValue)}`, color: 'green' });
        }
        result.push({ text: '' });
      }
    }

    return result;
  }, [fromVersion, toVersion, diffs]);

  const terminalHeight = stdout?.rows ?? 24;
  const displayHeight = Math.max(5, terminalHeight - 10);
  const maxScroll = Math.max(0, lines.length - displayHeight);

  useInput((_input, key) => {
    if (key.upArrow) setScrollOffset(prev => Math.max(0, prev - 1));
    if (key.downArrow) setScrollOffset(prev => Math.min(maxScroll, prev + 1));
  });

  if (isLoading) {
    return (
      <Screen title={`${bundleName} — Diff`} onExit={onExit}>
        <Text dimColor>Loading versions for diff...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title={`${bundleName} — Diff`} onExit={onExit}>
        <Text color="red">Error: {error}</Text>
      </Screen>
    );
  }

  const visibleLines = lines.slice(scrollOffset, scrollOffset + displayHeight);
  const needsScroll = lines.length > displayHeight;

  return (
    <Screen
      title={`${bundleName} — Diff`}
      onExit={onExit}
      helpText={needsScroll ? '↑↓ scroll · Esc back · Ctrl+C quit' : 'Esc back · Ctrl+C quit'}
    >
      <Panel fullWidth>
        <Box flexDirection="column" height={displayHeight}>
          {visibleLines.map((line, idx) => (
            <Text key={scrollOffset + idx} color={line.color as never} dimColor={line.color === 'gray'}>
              {line.text}
            </Text>
          ))}
        </Box>
        {needsScroll && (
          <Text dimColor>
            [{scrollOffset + 1}-{Math.min(scrollOffset + displayHeight, lines.length)} of {lines.length}]
          </Text>
        )}
      </Panel>
    </Screen>
  );
}
