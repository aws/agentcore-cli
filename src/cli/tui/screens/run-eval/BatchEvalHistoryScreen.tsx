import type { BatchEvalRunRecord } from '../../../operations/eval/batch-eval-storage';
import { listBatchEvalRuns } from '../../../operations/eval/batch-eval-storage';
import { Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatShortDate(timestamp: string): string {
  const d = new Date(timestamp);
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${mon} ${day} ${h12}:${m} ${ampm}`;
}

function statusColor(status: string): string {
  if (status === 'COMPLETED' || status === 'SUCCEEDED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'IN_PROGRESS' || status === 'PENDING') return 'yellow';
  return 'gray';
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────────────────────

function BatchEvalListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: BatchEvalRunRecord[];
  onSelect: (record: BatchEvalRunRecord) => void;
  onExit: () => void;
  availableHeight: number;
}) {
  const nav = useListNavigation({
    items: records,
    onSelect: item => onSelect(item),
    onExit,
    isActive: true,
  });

  const maxVisible = Math.max(1, availableHeight - 3);
  const visible = useMemo(() => {
    let start = 0;
    if (nav.selectedIndex >= maxVisible) {
      start = nav.selectedIndex - maxVisible + 1;
    }
    return { items: records.slice(start, start + maxVisible), startIdx: start };
  }, [records, nav.selectedIndex, maxVisible]);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text bold>Batch Evaluation History</Text>
        <Text dimColor>
          {records.length} batch evaluation{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.startedAt ? formatShortDate(rec.startedAt) : 'unknown';

            // Build a short score summary from evaluationResults or results
            const summaries = rec.evaluationResults?.evaluatorSummaries;
            let scoreText = '';
            if (summaries && summaries.length > 0) {
              scoreText = summaries
                .map(s => {
                  const avg = s.statistics?.averageScore;
                  return avg != null ? avg.toFixed(2) : 'N/A';
                })
                .join(', ');
            } else if (rec.results.length > 0) {
              const byEval = new Map<string, number[]>();
              for (const r of rec.results) {
                if (r.score != null) {
                  const scores = byEval.get(r.evaluatorId) ?? [];
                  scores.push(r.score);
                  byEval.set(r.evaluatorId, scores);
                }
              }
              scoreText = [...byEval.entries()]
                .map(([, scores]) => (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
                .join(', ');
            }

            return (
              <Text key={rec.batchEvaluationId} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '>' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(12)}</Text>
                {scoreText && <Text>{scoreText.padEnd(10)}</Text>}
                <Text dimColor>{rec.name}</Text>
              </Text>
            );
          })}
          {visible.startIdx + maxVisible < records.length && (
            <Text dimColor> {records.length - visible.startIdx - maxVisible} more</Text>
          )}
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail view
// ─────────────────────────────────────────────────────────────────────────────

function BatchEvalDetailView({ record, onBack }: { record: BatchEvalRunRecord; onBack: () => void }) {
  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
    }
  });

  const evalRes = record.evaluationResults;
  const summaries = evalRes?.evaluatorSummaries;

  // Fall back to local grouping when API summaries aren't available
  const byEvaluator = useMemo(() => {
    if (summaries && summaries.length > 0) return null;
    const map = new Map<string, { scores: number[]; errors: number }>();
    for (const r of record.results) {
      const entry = map.get(r.evaluatorId) ?? { scores: [], errors: 0 };
      if (r.error) {
        entry.errors++;
      } else if (r.score != null) {
        entry.scores.push(r.score);
      }
      map.set(r.evaluatorId, entry);
    }
    return map;
  }, [record.results, summaries]);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.batchEvaluationId}
        </Text>
        <Text>
          <Text bold>Name:</Text> {record.name}
          {'  '}
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Evaluators:</Text> {record.evaluators.join(', ')}
        </Text>
        {record.startedAt && (
          <Text>
            <Text bold>Started:</Text> {new Date(record.startedAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Completed:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        {evalRes?.totalNumberOfSessions != null && (
          <Text>
            <Text bold>Sessions:</Text> {evalRes.totalNumberOfSessions} total
            {evalRes.numberOfSessionsCompleted != null && <Text>, {evalRes.numberOfSessionsCompleted} completed</Text>}
            {evalRes.numberOfSessionsFailed ? <Text color="red">, {evalRes.numberOfSessionsFailed} failed</Text> : null}
          </Text>
        )}

        {summaries && summaries.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Scores (0 worst — 1 best):</Text>
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
            <Text bold>Scores (0 worst — 1 best):</Text>
            {[...byEvaluator.entries()].map(([evalId, { scores, errors }]) => {
              const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
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
            <Text dimColor>No evaluation results available.</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Press Esc or B to go back</Text>
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

interface BatchEvalHistoryScreenProps {
  onExit: () => void;
}

export function BatchEvalHistoryScreen({ onExit }: BatchEvalHistoryScreenProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [selectedRecord, setSelectedRecord] = useState<BatchEvalRunRecord | null>(null);

  const [records, loaded, error] = useMemo(() => {
    try {
      return [listBatchEvalRuns(), true, null] as const;
    } catch (err) {
      return [[] as BatchEvalRunRecord[], true, err instanceof Error ? err.message : String(err)] as const;
    }
  }, []);

  if (!loaded) {
    return (
      <Screen title="Batch Evaluation History [preview]" onExit={onExit}>
        <Text dimColor>Loading...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title="Batch Evaluation History [preview]" onExit={onExit}>
        <Text color="red">{error}</Text>
      </Screen>
    );
  }

  if (records.length === 0) {
    return (
      <Screen title="Batch Evaluation History [preview]" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No batch evaluation runs found.</Text>
          <Text dimColor>Run a batch evaluation from the TUI or CLI to see results here.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen
      title="Batch Evaluation History [preview]"
      onExit={onExit}
      helpText={helpText}
      exitEnabled={!selectedRecord}
    >
      {selectedRecord ? (
        <BatchEvalDetailView record={selectedRecord} onBack={() => setSelectedRecord(null)} />
      ) : (
        <BatchEvalListView
          records={records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
