import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
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
    .description('Fetch access info (URL, token, auth guidance) for a deployed gateway or agent.')
    .option('--name <resource>', 'Gateway or agent name')
    .option('--type <type>', 'Resource type: gateway (default) or agent', 'gateway')
    .option('--target <target>', 'Deployment target')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: Record<string, unknown>) => {
      const options = cliOptions as unknown as FetchAccessOptions;
      requireProject();

      let result: FetchAccessResult;
      try {
        result = await handleFetchAccess(options);
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
