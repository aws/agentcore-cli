import type { MetricDelta, TraceComparisonDeltas, TraceMetrics } from '../../operations/traces';
import { Box, Text } from 'ink';

function formatSeconds(value: number): string {
  return `${(value / 1000).toFixed(2)}s`;
}

function formatCount(value: number): string {
  return String(value);
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSide(value: number | undefined, format: (value: number) => string): string {
  return value === undefined ? '-' : format(value);
}

function formatDelta(entry: MetricDelta, format: (value: number) => string): string {
  if (entry.delta === undefined) return '-';
  const sign = entry.delta > 0 ? '+' : '';
  const percent =
    entry.deltaPercent === null || entry.deltaPercent === undefined
      ? ''
      : ` (${entry.deltaPercent > 0 ? '+' : ''}${entry.deltaPercent.toFixed(1)}%)`;
  return `${sign}${format(entry.delta)}${percent}`;
}

function buildComparisonRows(deltas: TraceComparisonDeltas) {
  return [
    { label: 'End-to-end latency', entry: deltas.endToEndMs, format: formatSeconds },
    { label: 'LLM latency', entry: deltas.llmMs, format: formatSeconds },
    { label: 'Tool latency', entry: deltas.toolMs, format: formatSeconds },
    { label: 'LLM calls', entry: deltas.llmCalls, format: formatCount },
    { label: 'Tool calls', entry: deltas.toolCalls, format: formatCount },
    { label: 'Input tokens', entry: deltas.inputTokens, format: formatTokens },
    { label: 'Output tokens', entry: deltas.outputTokens, format: formatTokens },
    { label: 'Total tokens', entry: deltas.totalTokens, format: formatTokens },
  ].filter(row => row.entry.baseline !== undefined || row.entry.candidate !== undefined);
}

export interface TraceComparisonViewProps {
  baseline: TraceMetrics;
  candidate: TraceMetrics;
  deltas: TraceComparisonDeltas;
  warnings: string[];
  consoleUrl?: string;
}

export function TraceComparisonView({ baseline, candidate, deltas, warnings, consoleUrl }: TraceComparisonViewProps) {
  const rows = buildComparisonRows(deltas);
  return (
    <Box flexDirection="column">
      <Text bold>
        Trace comparison: baseline {baseline.traceId} → candidate {candidate.traceId}
      </Text>
      <Text> </Text>
      <Box>
        <Box width={22}>
          <Text bold>Metric</Text>
        </Box>
        <Box width={14} justifyContent="flex-end">
          <Text bold>Baseline</Text>
        </Box>
        <Box width={14} justifyContent="flex-end">
          <Text bold>Candidate</Text>
        </Box>
        <Box width={24} justifyContent="flex-end">
          <Text bold>Delta</Text>
        </Box>
      </Box>
      {rows.map(row => (
        <Box key={row.label}>
          <Box width={22}>
            <Text>{row.label}</Text>
          </Box>
          <Box width={14} justifyContent="flex-end">
            <Text>{formatSide(row.entry.baseline, row.format)}</Text>
          </Box>
          <Box width={14} justifyContent="flex-end">
            <Text>{formatSide(row.entry.candidate, row.format)}</Text>
          </Box>
          <Box width={24} justifyContent="flex-end">
            <Text color="cyan">{formatDelta(row.entry, row.format)}</Text>
          </Box>
        </Box>
      ))}
      {(baseline.models ?? candidate.models) && (
        <>
          <Text> </Text>
          <Text>
            Baseline model(s): <Text color="magenta">{baseline.models?.join(', ') ?? '-'}</Text>
          </Text>
          <Text>
            Candidate model(s): <Text color="magenta">{candidate.models?.join(', ') ?? '-'}</Text>
          </Text>
        </>
      )}
      {warnings.length > 0 && <Text> </Text>}
      {warnings.map(warning => (
        <Text key={warning} color="yellow">
          Warning: {warning}
        </Text>
      ))}
      <Text> </Text>
      {consoleUrl && <Text color="gray">Console: {consoleUrl}</Text>}
    </Box>
  );
}
