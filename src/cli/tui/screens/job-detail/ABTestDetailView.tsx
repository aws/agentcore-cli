import { getErrorMessage } from '../../../errors';
import { isTerminal } from '../../../operations/jobs';
import type { ABTestJobRecord, DebugCheckResult, JobEngine } from '../../../operations/jobs';
import { getInvocationUrl } from '../../../operations/jobs/ab-test/format';
import { Panel } from '../../components';
import { lifecycleColor, statusColor } from './helpers';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useState } from 'react';

type ActionState = 'idle' | 'working' | 'error';

/**
 * Shared presentational detail view for an A/B-test job. Renders the panel body
 * only (the caller supplies the surrounding `Screen`). It owns the lifecycle
 * action keybindings (stop/pause/resume/promote) and the debug check action.
 *
 * Back/exit semantics are caller-controlled: `backKey` is the letter that, like
 * Escape, invokes `onBack`. Flow A (`agentcore view ab-test <id>`) uses `'q'`
 * ("exit"); the TUI history flow uses `'b'` ("back to list").
 */
export function ABTestDetailView({
  record,
  engine,
  onBack,
  onUpdate,
  backKey = 'b',
  backLabel = 'back',
}: {
  record: ABTestJobRecord;
  engine: JobEngine;
  onBack: () => void;
  onUpdate: (record: ABTestJobRecord) => void;
  backKey?: string;
  backLabel?: string;
}) {
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [debugResults, setDebugResults] = useState<DebugCheckResult[] | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const caps = engine.capabilities('ab-test');
  const terminal = isTerminal(record);
  const canStop = caps.canStop && !terminal;
  const canPause = caps.canPause && record.lifecycleStatus === 'RUNNING';
  const canResume = caps.canPause && record.lifecycleStatus === 'PAUSED';
  const canPromote = caps.canPromote && !terminal;

  const runAction = useCallback(
    async (fn: () => Promise<{ success: boolean; error?: { message: string } }>) => {
      setActionState('working');
      setActionError(null);
      try {
        const result = await fn();
        if (!result.success) {
          setActionState('error');
          setActionError(result.error?.message ?? 'Action failed');
          return;
        }
        const refreshed = await engine.get('ab-test', record.id);
        setActionState('idle');
        if (refreshed) onUpdate(refreshed);
      } catch (err) {
        setActionState('error');
        setActionError(getErrorMessage(err));
      }
    },
    [engine, record.id, onUpdate]
  );

  const handleDebug = useCallback(async () => {
    setDebugLoading(true);
    setDebugResults(null);
    try {
      const result = await engine.debug('ab-test', record.id);
      if (result.success) {
        setDebugResults(result.checks);
      } else {
        setDebugResults([{ label: 'Debug', status: 'fail', detail: result.error.message }]);
      }
    } catch {
      setDebugResults([{ label: 'Debug', status: 'fail', detail: 'Failed to run debug checks' }]);
    }
    setDebugLoading(false);
  }, [engine, record.id]);

  useInput((input, key) => {
    if (actionState === 'working' || debugLoading) return;
    if (key.escape || input === backKey) {
      onBack();
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 's' && canStop) void runAction(() => engine.stop('ab-test', record.id));
    else if (ch === 'p' && canPause) void runAction(() => engine.pause('ab-test', record.id));
    else if (ch === 'r' && canResume) void runAction(() => engine.resume('ab-test', record.id));
    else if (ch === 'w' && canPromote) void runAction(() => engine.promote('ab-test', record.id));
    else if (ch === 'd') void handleDebug();
  });

  const invocationUrl = getInvocationUrl(record);
  const metrics = record.results?.evaluatorMetrics;

  const keyHints = [
    `Esc/${backKey.toUpperCase()} ${backLabel}`,
    canStop ? 'S stop' : null,
    canPause ? 'P pause' : null,
    canResume ? 'R resume' : null,
    canPromote ? 'W promote' : null,
    'D debug',
  ].filter(Boolean);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Name:</Text> {record.name}
          {'  '}
          <Text bold>Mode:</Text> {record.mode}
        </Text>
        <Text>
          <Text bold>Execution:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
          {'  '}
          <Text bold>Lifecycle:</Text>{' '}
          <Text color={lifecycleColor(record.lifecycleStatus)}>{record.lifecycleStatus}</Text>
        </Text>
        <Text>
          <Text bold>Gateway:</Text> {record.gatewayArn}
        </Text>
        {invocationUrl && (
          <Text>
            <Text bold>Invocation URL:</Text> {invocationUrl}
          </Text>
        )}
        {record.createdAt && (
          <Text>
            <Text bold>Started:</Text> {new Date(record.createdAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Stopped:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Variants:</Text>
          {record.variants.map(v => {
            const detail = v.bundleArn
              ? `bundle ${v.bundleArn} @ ${v.bundleVersion}`
              : v.targetName
                ? `target ${v.targetName}`
                : '(unspecified)';
            return (
              <Text key={v.name}>
                {'  '}
                <Text bold>{v.name}</Text> (weight {v.weight}): <Text dimColor>{detail}</Text>
              </Text>
            );
          })}
        </Box>

        {metrics && metrics.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Results:</Text>
            {metrics.map(m => (
              <Box key={m.evaluatorArn} flexDirection="column">
                <Text dimColor>{m.evaluatorArn}</Text>
                <Text>
                  {'  '}C (n={m.controlStats.sampleSize}): {m.controlStats.mean.toFixed(3)}
                </Text>
                {m.variantResults.map(vr => (
                  <Text key={vr.treatmentName}>
                    {'  '}
                    {vr.treatmentName} (n={vr.sampleSize}): {vr.mean.toFixed(3)}
                    {vr.percentChange != null
                      ? ` (${vr.percentChange > 0 ? '+' : ''}${vr.percentChange.toFixed(1)}%)`
                      : ''}
                    {vr.isSignificant ? <Text color="green"> *significant*</Text> : null}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ) : record.failureReason ? (
          <Box marginTop={1}>
            <Text color="red">Failure: {record.failureReason}</Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor>No results available yet.</Text>
          </Box>
        )}

        {actionState === 'working' && (
          <Box marginTop={1}>
            <Text color="yellow">Working...</Text>
          </Box>
        )}
        {actionState === 'error' && actionError && (
          <Box marginTop={1}>
            <Text color="red">Action failed: {actionError}</Text>
          </Box>
        )}

        {debugLoading && (
          <Box marginTop={1}>
            <Text color="yellow">Running debug checks...</Text>
          </Box>
        )}
        {debugResults && (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Debug Checks:</Text>
            {debugResults.map((check, i) => {
              const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
              const color = check.status === 'pass' ? 'green' : check.status === 'warn' ? 'yellow' : 'red';
              return (
                <Text key={i}>
                  {'  '}
                  <Text color={color}>{icon}</Text> {check.label}: <Text dimColor>{check.detail}</Text>
                </Text>
              );
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>{keyHints.join(' · ')}</Text>
        </Box>
      </Box>
    </Panel>
  );
}
