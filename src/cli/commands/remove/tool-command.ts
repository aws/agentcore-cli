import { ConfigIO, findConfigRoot } from '../../../lib';
import { getErrorMessage } from '../../errors';
import type { Command } from '@commander-js/extra-typings';

export function registerRemoveTool(removeCmd: Command): void {
  removeCmd
    .command('tool')
    .description('Remove a tool from a harness')
    .requiredOption('--harness <name>', 'Target harness name')
    .requiredOption('--name <name>', 'Tool name to remove')
    .option('--json', 'Output as JSON')
    .action(async cliOptions => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }

      try {
        const configIO = new ConfigIO();
        let harnessSpec;
        try {
          harnessSpec = await configIO.readHarnessSpec(cliOptions.harness);
        } catch {
          const error = `Harness '${cliOptions.harness}' not found.`;
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
          return;
        }

        const toolIndex = harnessSpec.tools.findIndex(t => t.name === cliOptions.name);
        if (toolIndex === -1) {
          const error = `Tool '${cliOptions.name}' not found in harness '${cliOptions.harness}'`;
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
          return;
        }

        harnessSpec.tools.splice(toolIndex, 1);
        await configIO.writeHarnessSpec(cliOptions.harness, harnessSpec);

        const result = { success: true, harnessName: cliOptions.harness, toolName: cliOptions.name };
        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Removed tool '${cliOptions.name}' from harness '${cliOptions.harness}'.`);
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
