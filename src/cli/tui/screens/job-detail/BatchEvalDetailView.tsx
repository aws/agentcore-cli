import { getErrorMessage } from '../../../errors';
import { isTerminal } from '../../../operations/jobs';
import type { BatchEvaluationJobRecord, JobEngine } from '../../../operations/jobs';
import { Panel } from '../../components';
import { scoreColor, statusColor } from './helpers';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useState } from 'react';

type StopState = 'idle' | 'stopping' | 'error';

/**
 * Shared presentational detail view for a batch-evaluation job. Renders the
 * panel body only (the caller supplies the surrounding `Screen`). It owns the
 * stop keybinding.
 *
 * Back/exit semantics are caller-controlled: `backKey` is the letter that, like
 * Escape, invokes `onBack`. Flow A (`agentcore view batch-evaluation <id>`)
 * uses `'q'` ("exit"); the TUI history flow uses `'b'` ("back to list").
 */
export function BatchEvalDetailView({
  record,
  engine,
  onBack,
  onUpdate,
  backKey = 'b',
  backLabel = 'back',
}: {
  record: BatchEvaluationJobRecord;
  engine: JobEngine;
  onBack: () => void;
  onUpdate: (record: BatchEvaluationJobRecord) => void;
  backKey?: string;
  backLabel?: string;
}) {
  const [stopState, setStopState] = useState<StopState>('idle');
  const [stopError, setStopError] = useState<string | null>(null);

  const canStop = engine.capabilities('batch-evaluation').canStop && !isTerminal(record);

  const handleStop = useCallback(async () => {
    setStopState('stopping');
    setStopError(null);
    try {
      const result = await engine.stop('batch-evaluation', record.id);
      if (!result.success) {
        setStopState('error');
        setStopError(result.error.message);
        return;
      }
      const refreshed = await engine.get('batch-evaluation', record.id);
      setStopState('idle');
      if (refreshed) onUpdate(refreshed);
    } catch (err) {
      setStopState('error');
      setStopError(getErrorMessage(err));
    }
  }, [engine, record.id, onUpdate]);

  useInput((input, key) => {
    if (key.escape || input === backKey) {
      onBack();
      return;
    }
    if ((input === 's' || input === 'S') && canStop && stopState !== 'stopping') {
      void handleStop();
    }
  });

  const evalRes = record.evaluationResults;
  const summaries = evalRes?.evaluatorSummaries;

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Name:</Text> {record.name}
          {'  '}
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Agent:</Text> {record.agent}
          {'  '}
          <Text bold>Evaluators:</Text> {record.evaluators.join(', ')}
        </Text>
        {record.source === 'dataset' && record.dataset && (
          <Text>
            <Text bold>Dataset:</Text> {record.dataset.id} (version: {record.dataset.version})
          </Text>
        )}
        {record.createdAt && (
          <Text>
            <Text bold>Created:</Text> {new Date(record.createdAt).toLocaleString()}
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
        ) : (
          <Box marginTop={1}>
            <Text dimColor>No evaluation results available yet.</Text>
          </Box>
        )}

        {stopState === 'stopping' && (
          <Box marginTop={1}>
            <Text color="yellow">Stopping...</Text>
          </Box>
        )}
        {stopState === 'error' && stopError && (
          <Box marginTop={1}>
            <Text color="red">Could not stop: {stopError}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            Esc/{backKey.toUpperCase()} {backLabel}
            {canStop ? ' · S stop' : ''}
          </Text>
        </Box>
      </Box>
    </Panel>
  );
}
