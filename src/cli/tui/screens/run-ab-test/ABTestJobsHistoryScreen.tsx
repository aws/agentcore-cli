import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { ABTestJobRecord } from '../../../operations/jobs';
import { ErrorPrompt, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { ABTestDetailView, lifecycleColor, statusColor } from '../job-detail';
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

function ABTestListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: ABTestJobRecord[];
  onSelect: (record: ABTestJobRecord) => void;
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
        <Text bold>A/B Test Jobs</Text>
        <Text dimColor>
          {records.length} A/B test{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.createdAt ? formatShortDate(rec.createdAt) : 'unknown';
            return (
              <Text key={rec.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(10)}</Text>
                <Text color={lifecycleColor(rec.lifecycleStatus)}>{rec.lifecycleStatus.padEnd(10)}</Text>
                <Text>{rec.name}</Text>
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
  | { name: 'loaded'; records: ABTestJobRecord[] };

interface ABTestJobsHistoryScreenProps {
  onExit: () => void;
}

export function ABTestJobsHistoryScreen({ onExit }: ABTestJobsHistoryScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [selectedRecord, setSelectedRecord] = useState<ABTestJobRecord | null>(null);

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
        const records = await engine.list({ type: 'ab-test' });
        if (!cancelled) setFlow({ name: 'loaded', records });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine]);

  const handleUpdate = useCallback((updated: ABTestJobRecord) => {
    setSelectedRecord(updated);
    setFlow(prev =>
      prev.name === 'loaded' ? { ...prev, records: prev.records.map(r => (r.id === updated.id ? updated : r)) } : prev
    );
  }, []);

  if (flow.name === 'loading') {
    return (
      <Screen title="A/B Test Jobs" onExit={onExit}>
        <Text dimColor>Loading A/B test jobs...</Text>
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'error') {
    return (
      <Screen title="A/B Test Jobs" onExit={onExit}>
        <Text color="red">{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.records.length === 0) {
    return (
      <Screen title="A/B Test Jobs" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No A/B test jobs found.</Text>
          <Text dimColor>Run an A/B test from the TUI or CLI to see results here.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="A/B Test Jobs" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord}>
      {selectedRecord ? (
        <ABTestDetailView
          record={selectedRecord}
          engine={engine}
          onBack={() => setSelectedRecord(null)}
          onUpdate={handleUpdate}
        />
      ) : (
        <ABTestListView
          records={flow.records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
