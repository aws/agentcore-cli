import { handleImport } from './actions';
import type { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';

export const registerImport = (program: Command) => {
  program
    .command('import')
    .description('Import resources from a Bedrock AgentCore Starter Toolkit project')
    .requiredOption(
      '--source <path>',
      'Path to the .bedrock_agentcore.yaml configuration file'
    )
    .option('--target <target>', 'Deployment target name', 'default')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(
      async (cliOptions: { source: string; target: string; yes?: boolean }) => {
        // Validate source file exists
        if (!fs.existsSync(cliOptions.source)) {
          console.error(`Error: Source file not found: ${cliOptions.source}`);
          process.exit(1);
        }

        console.log('AgentCore Import: Migrating Starter Toolkit project to AgentCore CLI\n');

        const result = await handleImport({
          source: cliOptions.source,
          target: cliOptions.target,
          yes: cliOptions.yes,
          onProgress: (message: string) => {
            console.log(`  ${message}`);
          },
        });

        if (result.success) {
          console.log('\n--- Import Summary ---');
          if (result.importedAgents && result.importedAgents.length > 0) {
            console.log(`  Imported agents: ${result.importedAgents.join(', ')}`);
          }
          if (result.importedMemories && result.importedMemories.length > 0) {
            console.log(`  Imported memories: ${result.importedMemories.join(', ')}`);
          }
          console.log(`  Stack: ${result.stackName}`);

          console.log('\n--- Next Steps ---');
          console.log('  1. Review agentcore/agentcore.json');
          console.log('  2. Run `agentcore deploy` to reconcile the stack (Phase 3)');
          console.log('     This adds IAM policies, Outputs, and cross-references.');
          console.log('  3. Verify: `agentcore invoke`');
          console.log(
            '\n  Note: Original IAM roles are unchanged. After deploy, resources use new'
          );
          console.log('  CDK-synthesized roles. Delete original roles once confirmed working.');
        } else {
          console.error(`\nImport failed: ${result.error}`);
          process.exit(1);
        }
      }
    );
};
