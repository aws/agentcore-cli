import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { BatchEvaluationJobRecord } from '../../../operations/jobs';
import { ErrorPrompt, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { BatchEvalDetailView, scoreColor, statusColor } from '../job-detail';
import { Box, Text, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

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
  records: BatchEvaluationJobRecord[];
  onSelect: (record: BatchEvaluationJobRecord) => void;
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
        <Text bold>Batch Evaluation Jobs</Text>
        <Text dimColor>
          {records.length} batch evaluation{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.createdAt ? formatShortDate(rec.createdAt) : 'unknown';

            // Average score per evaluator, read straight from the API summaries in the record.
            const avgScores = (rec.evaluationResults?.evaluatorSummaries ?? [])
              .map(s => s.statistics?.averageScore)
              .filter((v): v is number => v != null);

            const datasetLabel =
              rec.source === 'dataset' && rec.dataset ? ` [${rec.dataset.id}@${rec.dataset.version}]` : '';

            return (
              <Text key={rec.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(12)}</Text>
                <Text dimColor>avg </Text>
                {avgScores.length > 0 ? (
                  avgScores.map((avg, i) => (
                    <Text key={i} color={scoreColor(avg)}>
                      {avg.toFixed(2)}
                      {i < avgScores.length - 1 ? <Text dimColor>, </Text> : ' '}
                    </Text>
                  ))
                ) : (
                  <Text dimColor>{'—'.padEnd(7)}</Text>
                )}
                <Text dimColor>{rec.name}</Text>
                {datasetLabel && <Text color="blue">{datasetLabel}</Text>}
              </Text>
            );
          })}
          {visible.startIdx + maxVisible < records.length && (
            <Text dimColor> ↓ {records.length - visible.startIdx - maxVisible} more</Text>
          )}
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

type FlowState =
  | { name: 'loading' }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string }
  | { name: 'loaded'; records: BatchEvaluationJobRecord[] };

interface BatchEvalHistoryScreenProps {
  onExit: () => void;
}

export function BatchEvalHistoryScreen({ onExit }: BatchEvalHistoryScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [selectedRecord, setSelectedRecord] = useState<BatchEvaluationJobRecord | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setFlow({ name: 'creds-error', message: getErrorMessage(err) });
        return;
      }

      try {
        const records = await engine.list({ type: 'batch-evaluation' });
        if (!cancelled) setFlow({ name: 'loaded', records });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine]);

  // Apply an updated record (e.g. after a stop) into both the selection and the list.
  const handleUpdate = useCallback((updated: BatchEvaluationJobRecord) => {
    setSelectedRecord(updated);
    setFlow(prev =>
      prev.name === 'loaded' ? { ...prev, records: prev.records.map(r => (r.id === updated.id ? updated : r)) } : prev
    );
  }, []);

  if (flow.name === 'loading') {
    return (
      <Screen title="Batch Evaluation Jobs" onExit={onExit}>
        <Text dimColor>Loading batch evaluation jobs...</Text>
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'error') {
    return (
      <Screen title="Batch Evaluation Jobs" onExit={onExit}>
        <Text color="red">{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.records.length === 0) {
    return (
      <Screen title="Batch Evaluation Jobs" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No batch evaluation jobs found.</Text>
          <Text dimColor>Run a batch evaluation from the TUI or CLI to see results here.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="Batch Evaluation Jobs" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord}>
      {selectedRecord ? (
        <BatchEvalDetailView
          record={selectedRecord}
          engine={engine}
          onBack={() => setSelectedRecord(null)}
          onUpdate={handleUpdate}
        />
      ) : (
        <BatchEvalListView
          records={flow.records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
