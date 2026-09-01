import { serializeResult } from '../../../lib';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { loadDeployedProjectConfig } from '../../operations/resolve-agent';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { getProjectRootMismatch, projectExists, requireProject } from '../../tui/guards';
import { handleTracesCompare, handleTracesGet, handleTracesList } from './action';
import { TraceComparisonView } from './comparison-view';
import type { TracesCompareOptions, TracesGetOptions, TracesListOptions } from './types';
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

function requireTracesProject(json?: boolean): boolean {
  if (!json) {
    requireProject();
    return true;
  }

  if (!projectExists()) {
    console.log(JSON.stringify({ success: false, error: 'No agentcore project found. Run agentcore create first.' }));
    process.exit(1);
    return false;
  }

  const projectRoot = getProjectRootMismatch();
  if (projectRoot) {
    console.log(
      JSON.stringify({
        success: false,
        error: `Please run this command from your project root directory: ${projectRoot}`,
      })
    );
    process.exit(1);
    return false;
  }

  return true;
}

export const registerTraces = (program: Command) => {
  const traces = program.command('traces').alias('t').description(COMMAND_DESCRIPTIONS.traces);

  traces
    .command('list')
    .description('List recent traces for a deployed runtime')
    .option('--runtime <name>', 'Select specific runtime')
    .option('--limit <n>', 'Maximum number of traces to display', '20')
    .option('--since <time>', 'Start time — defaults to 12h ago (e.g. 5m, 1h, 2d, ISO 8601, epoch ms)')
    .option('--until <time>', 'End time — defaults to now (e.g. now, 1h, ISO 8601, epoch ms)')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: TracesListOptions) => {
      try {
        if (!requireTracesProject(cliOptions.json)) return;
        const context = await loadDeployedProjectConfig();
        const result = await handleTracesList(context, cliOptions);

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            render(
              <Box flexDirection="column">
                <Text color="red">Error: {result.error.message}</Text>
                {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
              </Box>
            );
          }
          process.exit(1);
          return;
        }

        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult(result)));
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
                      <Text color="cyan">{trace.traceId}</Text>
                    </Box>
                    <Box width={22}>
                      <Text>{formatTimestamp(trace.timestamp)}</Text>
                    </Box>
                    <Box width={38}>
                      <Text color="magenta">{trace.sessionId ?? '-'}</Text>
                    </Box>
                  </Box>
                ))}
              </>
            ) : (
              <Text color="yellow">No traces found in the specified time range.</Text>
            )}
            <Text> </Text>
            {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
            {result.consoleUrl && <Text dimColor>Note: Traces may take 2-3 minutes to appear in CloudWatch</Text>}
          </Box>
        );
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });

  traces
    .command('get <traceId>')
    .description('Download a trace to a JSON file')
    .option('--runtime <name>', 'Select specific runtime')
    .option('--output <path>', 'Output file path')
    .option('--since <time>', 'Start time — defaults to 12h ago (e.g. 5m, 1h, 2d, ISO 8601, epoch ms)')
    .option('--until <time>', 'End time — defaults to now (e.g. now, 1h, ISO 8601, epoch ms)')
    .option('--json', 'Output as JSON')
    .action(async (traceId: string, cliOptions: TracesGetOptions) => {
      try {
        if (!requireTracesProject(cliOptions.json)) return;
        const context = await loadDeployedProjectConfig();
        const result = await handleTracesGet(context, traceId, cliOptions);

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            render(
              <Box flexDirection="column">
                <Text color="red">Error: {result.error.message}</Text>
                {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
              </Box>
            );
          }
          process.exit(1);
          return;
        }

        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult(result)));
          return;
        }

        render(
          <Box flexDirection="column">
            <Text color="green">Trace saved to: {result.filePath}</Text>
            {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
          </Box>
        );
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });

  traces
    .command('compare <baselineTraceId> <candidateTraceId>')
    .description('Compare latency and token metrics of two traces')
    .option('--runtime <name>', 'Select specific runtime')
    .option('--since <time>', 'Start time — defaults to 12h ago (e.g. 5m, 1h, 2d, ISO 8601, epoch ms)')
    .option('--until <time>', 'End time — defaults to now (e.g. now, 1h, ISO 8601, epoch ms)')
    .option('--json', 'Output as JSON')
    .action(async (baselineTraceId: string, candidateTraceId: string, cliOptions: TracesCompareOptions) => {
      try {
        if (!requireTracesProject(cliOptions.json)) return;
        const context = await loadDeployedProjectConfig();
        const result = await withCommandRunTelemetry('traces.compare', {}, () =>
          handleTracesCompare(context, baselineTraceId, candidateTraceId, cliOptions)
        );

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            render(
              <Box flexDirection="column">
                <Text color="red">Error: {result.error.message}</Text>
                {result.consoleUrl && <Text color="gray">Console: {result.consoleUrl}</Text>}
              </Box>
            );
          }
          process.exit(1);
          return;
        }

        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult(result)));
          return;
        }

        render(
          <TraceComparisonView
            baseline={result.baseline}
            candidate={result.candidate}
            deltas={result.deltas}
            warnings={result.warnings}
            consoleUrl={result.consoleUrl}
          />
        );
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });
};
