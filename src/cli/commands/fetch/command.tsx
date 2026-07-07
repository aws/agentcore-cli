import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { ResourceType, standardize } from '../../telemetry/schemas/common-shapes.js';
import { requireProject } from '../../tui/guards';
import { handleFetchAccess } from './action';
import type { FetchAccessResult } from './action';
import type { FetchAccessOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

export const registerFetch = (program: Command) => {
  const fetchCmd = program.command('fetch').description(COMMAND_DESCRIPTIONS.fetch);

  fetchCmd
    .command('access')
    .description('Fetch access info (URL, token, auth guidance) for a deployed gateway, agent, or harness.')
    .option('--name <resource>', 'Gateway, agent, or harness name [non-interactive]')
    .option('--type <type>', 'Resource type: gateway (default), agent, or harness [non-interactive]', 'gateway')
    .option('--target <target>', 'Deployment target [non-interactive]')
    .option('--identity-name <name>', 'Identity credential name for token fetch [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async (cliOptions: Record<string, unknown>) => {
      const options = cliOptions as unknown as FetchAccessOptions;
      requireProject();

      let result: FetchAccessResult;
      try {
        // Record cli.command_run for fetch.access. handleFetchAccess runs exactly once inside
        // the telemetry wrapper; its string-error shape is adapted to the Result {success,
        // error: Error} the telemetry layer expects (used only for exit_reason/error_name),
        // while the original result is captured via closure to drive output below.
        let captured: FetchAccessResult;
        await withCommandRunTelemetry(
          'fetch.access',
          { resource_type: standardize(ResourceType, options.type ?? 'gateway') },
          async () => {
            captured = await handleFetchAccess(options);
            return captured.success
              ? { success: true as const }
              : { success: false as const, error: new Error(captured.error) };
          }
        );
        result = captured!;
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
        return;
      }

      if (!result.success) {
        if (options.json) {
          console.log(
            JSON.stringify({
              success: false,
              error: result.error,
              ...(result.availableGateways && { availableGateways: result.availableGateways }),
            })
          );
        } else if (!result.availableGateways) {
          render(<Text color="red">{result.error}</Text>);
        } else {
          render(
            <Box flexDirection="column">
              <Text color="red">{result.error}</Text>
              <Text>Available gateways:</Text>
              {result.availableGateways.map(gw => (
                <Text key={gw.name}>
                  {'  '}
                  {gw.name} [{gw.authType}]
                </Text>
              ))}
            </Box>
          );
        }
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ success: true, ...result.result }, null, 2));
        return;
      }

      const r = result.result!;
      render(
        <Box flexDirection="column">
          <Text>
            <Text bold>URL:</Text>
            <Text color="green"> {r.url}</Text>
          </Text>
          <Text>
            <Text bold>Auth:</Text> {r.authType}
          </Text>
          {r.message && <Text>{r.message}</Text>}
          {r.token && (
            <Text>
              <Text bold>Token:</Text> {r.token}
            </Text>
          )}
          {r.expiresIn !== undefined && (
            <Text>
              <Text bold>Expires in:</Text> {r.expiresIn}s
            </Text>
          )}
        </Box>
      );
    });
};
