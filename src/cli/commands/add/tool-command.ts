import { findConfigRoot } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { handleAddTool } from './tool-action';
import type { Command } from '@commander-js/extra-typings';

export function registerAddTool(addCmd: Command): void {
  addCmd
    .command('tool')
    .description('Add a tool to a harness')
    .requiredOption('--harness <name>', 'Target harness name')
    .requiredOption(
      '--type <type>',
      'Tool type: agentcore_browser, agentcore_code_interpreter, remote_mcp, agentcore_gateway, inline_function'
    )
    .requiredOption('--name <name>', 'Tool name')
    .option('--url <url>', 'MCP server URL (required for remote_mcp)')
    .option('--browser-arn <arn>', 'Custom browser ARN (optional for agentcore_browser)')
    .option('--code-interpreter-arn <arn>', 'Custom code interpreter ARN (optional for agentcore_code_interpreter)')
    .option('--gateway-arn <arn>', 'Gateway ARN (for agentcore_gateway)')
    .option('--gateway <name>', 'Project gateway name — resolves ARN from deployed state (for agentcore_gateway)')
    .option(
      '--outbound-auth <type>',
      'Gateway outbound auth: awsIam, none, or oauth (default: awsIam if omitted) [agentcore_gateway]'
    )
    .option('--provider-arn <arn>', 'OAuth credential provider ARN (required when --outbound-auth oauth)')
    .option(
      '--scopes <scopes>',
      'Comma-separated OAuth scopes (required when --outbound-auth oauth), e.g. "openid,profile" or "https://api.example.com/read"'
    )
    .option(
      '--grant-type <type>',
      'OAuth grant type: CLIENT_CREDENTIALS or USER_FEDERATION (for --outbound-auth oauth)'
    )
    .option('--json', 'Output as JSON')
    .action(async cliOptions => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }

      try {
        const result = await handleAddTool({
          harness: cliOptions.harness,
          type: cliOptions.type,
          name: cliOptions.name,
          url: cliOptions.url,
          browserArn: cliOptions.browserArn,
          codeInterpreterArn: cliOptions.codeInterpreterArn,
          gatewayArn: cliOptions.gatewayArn,
          gateway: cliOptions.gateway,
          outboundAuth: cliOptions.outboundAuth,
          providerArn: cliOptions.providerArn,
          scopes: cliOptions.scopes,
          grantType: cliOptions.grantType,
          json: cliOptions.json,
        });

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else {
            console.error(result.error);
          }
          process.exit(1);
        }

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Added tool '${result.toolName}' to harness '${result.harnessName}'.`);
          console.log(`Run 'agentcore deploy' to apply changes.`);
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(getErrorMessage(error));
        }
        process.exit(1);
      }
    });
}
