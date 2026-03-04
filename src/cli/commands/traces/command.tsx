import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { handleTracesGet, handleTracesList, loadTracesConfig } from './action';
import type { TracesGetOptions, TracesListOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

function formatTimestamp(ts: string): string {
  const num = Number(ts);
  if (isNaN(num)) return ts;
  // Epoch ms → human-readable
  return new Date(num)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

export const registerTraces = (program: Command) => {
  const traces = program.command('traces').alias('t').description(COMMAND_DESCRIPTIONS.traces);

  traces
    .command('list')
    .description('List recent traces for a deployed agent')
    .option('--agent <name>', 'Select specific agent')
    .option('--limit <n>', 'Maximum number of traces to display', '20')
    .action(async (cliOptions: TracesListOptions) => {
      requireProject();

      try {
        const context = await loadTracesConfig();
        const result = await handleTracesList(context, cliOptions);

        if (!result.success) {
          render(
            <Box flexDirection="column">
              <Text color="red">Error: {result.error}</Text>
              {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
            </Box>
          );
          process.exit(1);
          return;
        }

        render(
          <Box flexDirection="column">
            <Text bold>
              Traces for {result.agentName} (target: {result.targetName})
            </Text>
            <Text> </Text>
            {result.traces && result.traces.length > 0 ? (
              <>
                <Box>
                  <Box width={34}>
                    <Text bold>Trace ID</Text>
                  </Box>
                  <Box width={22}>
                    <Text bold>Timestamp</Text>
                  </Box>
                  <Box width={38}>
                    <Text bold>Session ID</Text>
                  </Box>
                </Box>
                {result.traces.map((trace, i) => (
                  <Box key={i}>
                    <Box width={34}>
                      <Text color="cyan">{trace.traceId.slice(0, 32)}</Text>
                    </Box>
                    <Box width={22}>
                      <Text>{formatTimestamp(trace.timestamp)}</Text>
                    </Box>
                    <Box width={38}>
                      <Text color="magenta">{trace.sessionId?.slice(0, 36) ?? '-'}</Text>
                    </Box>
                  </Box>
                ))}
              </>
            ) : (
              <Text color="yellow">No traces found in the last 12 hours.</Text>
            )}
            <Text> </Text>
            {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });

  traces
    .command('get <traceId>')
    .description('Download a trace to a JSON file')
    .option('--agent <name>', 'Select specific agent')
    .option('--output <path>', 'Output file path')
    .action(async (traceId: string, cliOptions: TracesGetOptions) => {
      requireProject();

      try {
        const context = await loadTracesConfig();
        const result = await handleTracesGet(context, traceId, cliOptions);

        if (!result.success) {
          render(
            <Box flexDirection="column">
              <Text color="red">Error: {result.error}</Text>
              {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
            </Box>
          );
          process.exit(1);
          return;
        }

        render(
          <Box flexDirection="column">
            <Text color="green">Trace saved to: {result.filePath}</Text>
            {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
