import { getErrorMessage } from '../../errors';
import { fetchGatewayToken, listGateways } from '../../operations/fetch-access';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';
import React from 'react';

export const registerFetch = (program: Command) => {
  const fetchCmd = program.command('fetch').description(COMMAND_DESCRIPTIONS.fetch);

  fetchCmd
    .command('access')
    .description('Fetch access info (URL, token, auth guidance) for a deployed gateway.')
    .option('--name <resource>', 'Gateway name')
    .option('--target <target>', 'Deployment target')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { name?: string; target?: string; json?: boolean }) => {
      requireProject();

      if (!cliOptions.name) {
        try {
          const gateways = await listGateways({ deployTarget: cliOptions.target });
          if (cliOptions.json) {
            console.log(
              JSON.stringify({
                success: false,
                error:
                  gateways.length === 0
                    ? 'No deployed gateways found. Run `agentcore deploy` first.'
                    : 'Missing required option: --name',
                ...(gateways.length > 0 && { availableGateways: gateways }),
              })
            );
          } else if (gateways.length === 0) {
            render(<Text color="red">No deployed gateways found. Run `agentcore deploy` first.</Text>);
          } else {
            render(
              <Box flexDirection="column">
                <Text color="red">Missing required option: --name</Text>
                <Text>Available gateways:</Text>
                {gateways.map(gw => (
                  <Text key={gw.name}>
                    {'  '}
                    {gw.name} [{gw.authType}]
                  </Text>
                ))}
              </Box>
            );
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          }
        }
        process.exit(1);
      }

      try {
        const result = await fetchGatewayToken(cliOptions.name, {
          deployTarget: cliOptions.target,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }, null, 2));
          return;
        }

        render(
          <Box flexDirection="column">
            <Text>
              <Text bold>URL:</Text>
              <Text color="green"> {result.url}</Text>
            </Text>
            <Text>
              <Text bold>Auth:</Text> {result.authType}
            </Text>
            {result.message && <Text>{result.message}</Text>}
            {result.token && (
              <Text>
                <Text bold>Token:</Text> {result.token}
              </Text>
            )}
            {result.expiresIn !== undefined && (
              <Text>
                <Text bold>Expires in:</Text> {result.expiresIn}s
              </Text>
            )}
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
};
