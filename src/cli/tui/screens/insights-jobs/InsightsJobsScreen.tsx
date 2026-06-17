import type { FailureAnalysisResult, GetBatchEvaluationResult } from '../../../aws/agentcore-batch-evaluation';
import { getBatchEvaluation } from '../../../aws/agentcore-batch-evaluation';
import type { InsightsRunRecord } from '../../../operations/insights';
import { listInsightsRuns } from '../../../operations/insights';
import { Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────────────────────

function InsightsJobsListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: InsightsRunRecord[];
  onSelect: (record: InsightsRunRecord) => void;
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
        <Text bold>Insights Jobs</Text>
        <Text dimColor>
          {records.length} insights run{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.createdAt ? formatShortDate(rec.createdAt) : 'unknown';

            return (
              <Text key={rec.batchEvaluationId} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '>' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(12)}</Text>
                <Text dimColor>{rec.name || rec.batchEvaluationId}</Text>
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
// Results view
// ─────────────────────────────────────────────────────────────────────────────

function InsightsResultsView({ record, onBack }: { record: InsightsRunRecord; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failureAnalysis, setFailureAnalysis] = useState<FailureAnalysisResult | undefined>(undefined);
  const [totalSessions, setTotalSessions] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result: GetBatchEvaluationResult = await getBatchEvaluation({
          region: record.region,
          batchEvaluationId: record.batchEvaluationId,
        });
        if (cancelled) return;
        if (result.status !== 'COMPLETED' && result.status !== 'COMPLETEDWITHERRORS') {
          setError(`Job has status ${result.status}. Results are only available for completed jobs.`);
        } else {
          setFailureAnalysis(result.failureAnalysisResult);
          setTotalSessions(result.evaluationResults?.totalNumberOfSessions ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [record.batchEvaluationId, record.region]);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
    }
  });

  if (loading) {
    return (
      <Panel fullWidth>
        <Text dimColor>Loading results...</Text>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="red">{error}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Esc or B to go back</Text>
          </Box>
        </Box>
      </Panel>
    );
  }

  const categories = failureAnalysis?.failureCategories ?? [];

  if (categories.length === 0) {
    return (
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text dimColor>No failure categories found in this insights run.</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Esc or B to go back</Text>
          </Box>
        </Box>
      </Panel>
    );
  }

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text bold>Insights Results: {record.name || record.batchEvaluationId}</Text>
        <Text dimColor>
          Sessions: {totalSessions} | Clusters: {categories.length}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {categories.map((cat, i) => {
            const failureCount = cat.rootCauses?.length ?? 0;
            const pct = totalSessions > 0 ? Math.round((failureCount / totalSessions) * 100) : 0;
            const impact = pct >= 20 ? 'HIGH IMPACT' : pct >= 10 ? 'MEDIUM' : '';

            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text bold>
                    #{i + 1} ({pct}% of sessions)
                  </Text>
                  {impact ? <Text color={pct >= 20 ? 'red' : 'yellow'}> {impact}</Text> : null}
                </Text>
                <Text>
                  {'  '}Category: {cat.failureCategoryName ?? 'Unknown'}
                </Text>
                {cat.failureCategoryDescription && (
                  <Text dimColor>
                    {'  '}
                    {cat.failureCategoryDescription}
                  </Text>
                )}
                {(cat.rootCauses ?? []).map((rc, rcIdx) => (
                  <Box key={rcIdx} flexDirection="column" marginLeft={2}>
                    <Text>Root cause: {rc.rootCauseDescription ?? rc.rootCauseCategory ?? 'Unknown'}</Text>
                    {rc.recommendation && <Text color="green">Fix: {rc.recommendation}</Text>}
                    {rc.relatedSessions?.[0]?.recommendationType && (
                      <Text dimColor>Fix type: {rc.relatedSessions[0].recommendationType}</Text>
                    )}
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc or B to go back</Text>
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail view
// ─────────────────────────────────────────────────────────────────────────────

function InsightsJobDetailView({
  record,
  onBack,
  onViewResults,
}: {
  record: InsightsRunRecord;
  onBack: () => void;
  onViewResults: () => void;
}) {
  const isCompleted = record.status === 'COMPLETED' || record.status === 'COMPLETEDWITHERRORS';

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
    }
    if ((input === 'v' || input === 'V') && isCompleted) {
      onViewResults();
    }
  });

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.batchEvaluationId}
        </Text>
        <Text>
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Insights type(s):</Text> {record.insights.join(', ')}
        </Text>
        {record.agent && (
          <Text>
            <Text bold>Agent:</Text> {record.agent}
          </Text>
        )}
        {record.createdAt && (
          <Text>
            <Text bold>Started:</Text> {new Date(record.createdAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Completed:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Sessions:</Text>
          <Text>
            {'  '}total: {record.sessionCount ?? 'N/A'}
            {record.sessionsCompleted != null && <Text>, completed: {record.sessionsCompleted}</Text>}
            {record.sessionsFailed != null && record.sessionsFailed > 0 && (
              <Text color="red">, failed: {record.sessionsFailed}</Text>
            )}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            To generate a recommendation: agentcore run recommendation --from-insights {record.batchEvaluationId}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{isCompleted ? 'V view results - ' : ''}G generate recommendation - Esc back</Text>
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

interface InsightsJobsScreenProps {
  onExit: () => void;
}

export function InsightsJobsScreen({ onExit }: InsightsJobsScreenProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [selectedRecord, setSelectedRecord] = useState<InsightsRunRecord | null>(null);
  const [viewingResults, setViewingResults] = useState(false);

  const [records, loaded, error] = useMemo(() => {
    try {
      return [listInsightsRuns(), true, null] as const;
    } catch (err) {
      return [[] as InsightsRunRecord[], true, err instanceof Error ? err.message : String(err)] as const;
    }
  }, []);

  if (!loaded) {
    return (
      <Screen title="Insights Jobs" onExit={onExit}>
        <Text dimColor>Loading...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title="Insights Jobs" onExit={onExit}>
        <Text color="red">{error}</Text>
      </Screen>
    );
  }

  if (records.length === 0) {
    return (
      <Screen title="Insights Jobs" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No insights runs found. Run `agentcore run insights` to get started.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = viewingResults
    ? 'Esc/B back to detail'
    : selectedRecord
      ? 'V view results - Esc/B back to list'
      : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="Insights Jobs" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord && !viewingResults}>
      {viewingResults && selectedRecord ? (
        <InsightsResultsView record={selectedRecord} onBack={() => setViewingResults(false)} />
      ) : selectedRecord ? (
        <InsightsJobDetailView
          record={selectedRecord}
          onBack={() => setSelectedRecord(null)}
          onViewResults={() => setViewingResults(true)}
        />
      ) : (
        <InsightsJobsListView
          records={records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
