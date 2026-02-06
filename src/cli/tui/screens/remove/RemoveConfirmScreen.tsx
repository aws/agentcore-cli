import type { RemovalPreview, SchemaChange } from '../../../operations/remove';
import { Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';

interface RemoveConfirmScreenProps {
  /** Title for the confirmation screen */
  title: string;
  /** Preview data showing what will be removed */
  preview: RemovalPreview;
  /** Called when user confirms the removal */
  onConfirm: () => void;
  /** Called when user cancels */
  onCancel: () => void;
}

/**
 * Compute a unified diff between two JSON objects using LCS algorithm.
 * Groups removals and additions together properly.
 */
function computeJsonDiff(before: unknown, after: unknown): string[] {
  const beforeLines = JSON.stringify(before, null, 2).split('\n');
  const afterLines = JSON.stringify(after, null, 2).split('\n');

  // Build LCS table
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to build diff
  let i = m;
  let j = n;

  const tempDiff: string[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      tempDiff.unshift(`  ${beforeLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      tempDiff.unshift(`+ ${afterLines[j - 1]}`);
      j--;
    } else if (i > 0) {
      tempDiff.unshift(`- ${beforeLines[i - 1]}`);
      i--;
    }
  }

  // Group consecutive removals and additions together
  const grouped: string[] = [];
  let pendingRemovals: string[] = [];
  let pendingAdditions: string[] = [];

  const flushPending = () => {
    grouped.push(...pendingRemovals);
    grouped.push(...pendingAdditions);
    pendingRemovals = [];
    pendingAdditions = [];
  };

  for (const line of tempDiff) {
    if (line.startsWith('- ')) {
      if (pendingAdditions.length > 0) {
        flushPending();
      }
      pendingRemovals.push(line);
    } else if (line.startsWith('+ ')) {
      pendingAdditions.push(line);
    } else {
      flushPending();
      grouped.push(line);
    }
  }
  flushPending();

  // Filter to only show changed lines and some context
  return filterDiffWithContext(grouped, 2);
}

/**
 * Filter diff to show only changes with surrounding context.
 */
function filterDiffWithContext(diff: string[], contextLines: number): string[] {
  const result: string[] = [];
  const changeIndices: number[] = [];

  // Find all change indices
  diff.forEach((line, idx) => {
    if (line.startsWith('- ') || line.startsWith('+ ')) {
      changeIndices.push(idx);
    }
  });

  if (changeIndices.length === 0) {
    return ['  (no changes)'];
  }

  // Build set of indices to include
  const includeIndices = new Set<number>();
  for (const idx of changeIndices) {
    for (let i = Math.max(0, idx - contextLines); i <= Math.min(diff.length - 1, idx + contextLines); i++) {
      includeIndices.add(i);
    }
  }

  // Build result with ellipsis for gaps
  let lastIncluded = -2;
  for (let i = 0; i < diff.length; i++) {
    if (includeIndices.has(i)) {
      if (lastIncluded < i - 1 && lastIncluded >= 0) {
        result.push('  ...');
      }
      result.push(diff[i]!);
      lastIncluded = i;
    }
  }

  return result;
}

interface ScrollableDiffProps {
  changes: SchemaChange[];
  maxHeight?: number;
  minHeight?: number;
}

/**
 * Scrollable diff view with colored lines.
 */
function ScrollableDiff({ changes, maxHeight = 30, minHeight = 6 }: ScrollableDiffProps) {
  const { stdout } = useStdout();
  const [scrollOffset, setScrollOffset] = useState(0);

  // Compute all diff lines
  const lines = useMemo(() => {
    const result: string[] = [];
    for (const change of changes) {
      result.push(`─── ${change.file} ───`);
      const diffLines = computeJsonDiff(change.before, change.after);
      result.push(...diffLines);
    }
    return result;
  }, [changes]);

  // Calculate display height
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(minHeight, Math.min(maxHeight, terminalHeight - 14));
  const displayHeight = Math.min(availableHeight, lines.length);

  const totalLines = lines.length;
  const maxScroll = Math.max(0, totalLines - displayHeight);
  const needsScroll = totalLines > displayHeight;

  useInput((_input, key) => {
    if (!needsScroll) return;
    if (key.upArrow) setScrollOffset(prev => Math.max(0, prev - 1));
    if (key.downArrow) setScrollOffset(prev => Math.min(maxScroll, prev + 1));
  });

  const visibleLines = lines.slice(scrollOffset, scrollOffset + displayHeight);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={needsScroll ? displayHeight : undefined}>
        {visibleLines.map((line, idx) => {
          // File header
          if (line.startsWith('───')) {
            return (
              <Text key={scrollOffset + idx} bold color="cyan">
                {line}
              </Text>
            );
          }
          // Removed line
          if (line.startsWith('- ')) {
            return (
              <Text key={scrollOffset + idx} color="red">
                {line}
              </Text>
            );
          }
          // Added line
          if (line.startsWith('+ ')) {
            return (
              <Text key={scrollOffset + idx} color="green">
                {line}
              </Text>
            );
          }
          // Context line
          return (
            <Text key={scrollOffset + idx} dimColor>
              {line}
            </Text>
          );
        })}
      </Box>
      {needsScroll && (
        <Text dimColor>
          [{scrollOffset + 1}-{Math.min(scrollOffset + displayHeight, totalLines)} of {totalLines}] ↑↓ scroll
        </Text>
      )}
    </Box>
  );
}

export function RemoveConfirmScreen({ title, preview, onConfirm, onCancel }: RemoveConfirmScreenProps) {
  useInput((input, key) => {
    if (key.return) {
      onConfirm();
    }
    if (key.escape) {
      onCancel();
    }
  });

  // Build header content in a box for visual separation
  const headerContent = (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {preview.summary.map((line, idx) => {
        // Parse "Key: Value" format for colored display
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0 && colonIdx < 20) {
          const label = line.slice(0, colonIdx + 1);
          const value = line.slice(colonIdx + 1);
          return (
            <Box key={idx}>
              <Text>{label}</Text>
              <Text color="cyan">{value}</Text>
            </Box>
          );
        }
        // Special handling for cascade/restrict info
        if (line.startsWith('[cascade]')) {
          return (
            <Text key={idx} color="yellow">
              {line}
            </Text>
          );
        }
        if (line.startsWith('BLOCKED')) {
          return (
            <Text key={idx} color="red">
              {line}
            </Text>
          );
        }
        return <Text key={idx}>{line}</Text>;
      })}
    </Box>
  );

  return (
    <Screen title={title} onExit={onCancel} helpText={HELP_TEXT.CONFIRM_CANCEL} headerContent={headerContent}>
      <Box flexDirection="column" flexGrow={1}>
        {/* Schema diff with scrolling */}
        {preview.schemaChanges.length > 0 && <ScrollableDiff changes={preview.schemaChanges} />}

        {/* Action prompt at bottom */}
        <Box marginTop={1}>
          <Text color="yellow">▶ </Text>
          <Text>Press </Text>
          <Text bold color="green">
            Enter
          </Text>
          <Text> to remove, </Text>
          <Text bold>Esc</Text>
          <Text> to cancel</Text>
        </Box>
      </Box>
    </Screen>
  );
}
