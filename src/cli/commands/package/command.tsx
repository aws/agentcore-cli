import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { handlePackage, loadPackageConfig } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

export const registerPackage = (program: Command) => {
  program
    .command('package')
    .alias('pkg')
    .option('-d, --directory <path>', 'Project directory containing agentcore config')
    .option('-a, --agent <name>', 'Package only the specified agent')
    .description(COMMAND_DESCRIPTIONS.package)
    .action(async options => {
      try {
        const context = await loadPackageConfig(options);
        const result = await handlePackage(context);

        // Report skipped agents
        for (const name of result.skipped) {
          render(<Text color="yellow">Skipping {name}: ContainerImage artifacts not supported</Text>);
        }

        if (result.results.length === 0) {
          render(<Text color="yellow">No agents to package</Text>);
          return;
        }

        // Report successful packages
        for (const { agentName, artifactPath, sizeMb } of result.results) {
          render(
            <Text color="green">
              ✓ {agentName}: {artifactPath} ({sizeMb} MB)
            </Text>
          );
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
