import { handleImport } from './actions';
import type { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

export const registerImport = (program: Command) => {
  program
    .command('import')
    .description('Import resources from a Bedrock AgentCore Starter Toolkit project')
    .requiredOption('--source <path>', 'Path to the .bedrock_agentcore.yaml configuration file')
    .option('--target <target>', 'Deployment target name (only needed if project has multiple targets)')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: { source: string; target?: string; yes?: boolean }) => {
      // Validate source file exists
      if (!fs.existsSync(cliOptions.source)) {
        console.error(`\x1b[31m[error]${reset} Source file not found: ${cliOptions.source}`);
        process.exit(1);
      }

      const warnings: string[] = [];

      const result = await handleImport({
        source: cliOptions.source,
        target: cliOptions.target,
        yes: cliOptions.yes,
        onProgress: (message: string) => {
          // Collect warnings for end-of-output display
          if (message.includes('Warning') || message.includes('\x1b[33m')) {
            warnings.push(message);
            return;
          }

          // Skipped items shown dimmed
          if (message.startsWith('Skipping')) {
            console.log(`${dim}[skip]${reset}  ${message}`);
            return;
          }

          // Normal progress steps shown as [done]
          console.log(`${green}[done]${reset}  ${message}`);
        },
      });

      if (result.success) {
        // Summary
        console.log('');
        console.log(`${green}Import complete!${reset}`);

        console.log('');
        console.log(`${dim}Imported:${reset}`);
        console.log(`  Stack: ${result.stackName}`);
        if (result.importedAgents && result.importedAgents.length > 0) {
          for (const agent of result.importedAgents) {
            console.log(`  Agent: ${agent}`);
          }
        }
        if (result.importedMemories && result.importedMemories.length > 0) {
          for (const mem of result.importedMemories) {
            console.log(`  Memory: ${mem}`);
          }
        }

        // Show collected warnings
        if (warnings.length > 0) {
          console.log('');
          for (const w of warnings) {
            console.log(`${yellow}[warn]${reset}  ${w}`);
          }
        }

        // Next steps
        console.log('');
        console.log('To continue:');
        console.log('');
        console.log(`  ${cyan}agentcore deploy${reset}     ${dim}Deploy the imported stack${reset}`);
        console.log(`  ${cyan}agentcore status${reset}     ${dim}Verify resource status${reset}`);
        console.log(`  ${cyan}agentcore invoke${reset}     ${dim}Test your agent${reset}`);
        console.log('');
        if (result.logPath) {
          console.log(`Log: ${result.logPath}`);
        }
      } else {
        console.error(`\n\x1b[31m[error]${reset} Import failed: ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
};
