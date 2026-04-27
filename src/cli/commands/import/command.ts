import { handleImport } from './actions';
import { ANSI } from './constants';
import { registerImportEvaluator } from './import-evaluator';
import { registerImportGateway } from './import-gateway';
import { registerImportMemory } from './import-memory';
import { registerImportOnlineEval } from './import-online-eval';
import { registerImportRuntime } from './import-runtime';
import type { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';

const { green, yellow, cyan, dim, reset } = ANSI;

export const registerImport = (program: Command) => {
  const importCmd = program
    .command('import')
    .description('Import a runtime, memory, gateway, or starter toolkit into this project.');

  // Existing YAML flow: agentcore import --source <path>
  importCmd
    .option('--source <path>', 'Path to the .bedrock_agentcore.yaml configuration file')
    .option('--target <target>', 'Deployment target name (only needed if project has multiple targets)')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: { source?: string; target?: string; yes?: boolean }) => {
      if (!cliOptions.source) {
        // No --source and no subcommand — launch interactive TUI
        const { requireProject } = await import('../../tui/guards/project');
        requireProject();
        const { render } = await import('ink');
        const React = await import('react');
        const { ImportFlow } = await import('../../tui/screens/import');
        const inkRef: { current?: { clear: () => void; unmount: () => void } } = {};

        const exitTui = () => {
          inkRef.current?.clear();
          inkRef.current?.unmount();
        };

        const navigateTo = async (command: string) => {
          exitTui();
          if (command === 'deploy') {
            const { DeployScreen } = await import('../../tui/screens/deploy/DeployScreen');
            const deployInstance = render(
              React.createElement(DeployScreen, {
                isInteractive: false,
                onExit: () => {
                  deployInstance.unmount();
                  process.exit(0);
                },
              })
            );
          } else if (command === 'status') {
            const { StatusScreen } = await import('../../tui/screens/status/StatusScreen');
            const statusInstance = render(
              React.createElement(StatusScreen, {
                isInteractive: false,
                onExit: () => {
                  statusInstance.unmount();
                  process.exit(0);
                },
              })
            );
          }
        };

        inkRef.current = render(
          React.createElement(ImportFlow, {
            onBack: exitTui,
            onNavigate: (command: string) => void navigateTo(command),
          })
        );
        return;
      }

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

  // Register subcommands for importing individual resource types from AWS
  registerImportRuntime(importCmd);
  registerImportMemory(importCmd);
  registerImportEvaluator(importCmd);
  registerImportOnlineEval(importCmd);
  registerImportGateway(importCmd);
};
