import { findConfigRoot } from '../../../lib';
import { serializeResult } from '../../../lib/result';
import { ANSI, COMMAND_DESCRIPTIONS } from '../../constants';
import { renderTUI } from '../../tui/render';
import { handleExportHarness } from './harness-action';
import { formatExportNotes } from './types';
import type { Command } from '@commander-js/extra-typings';

const { green, red, cyan, dim, yellow, reset } = ANSI;

export function registerExport(program: Command): void {
  const exportCmd = program
    .command('export')
    .description(COMMAND_DESCRIPTIONS.export)
    .showHelpAfterError()
    .showSuggestionAfterError();

  exportCmd
    .command('harness')
    .description('Export a harness to a Python Strands runtime agent (in-project via --name, or by --arn)')
    .option('--name <name>', 'In-project harness name [non-interactive]')
    .option('--arn <arn>', 'ARN of a harness created outside this project — fetched from the service [non-interactive]')
    .option(
      '--target-agent-name <name>',
      'Name for the generated runtime agent (default: <harnessName>Agent) [non-interactive]'
    )
    .option('--build <type>', 'Build type: CodeZip or Container [non-interactive]')
    .option('--json', 'Output results as JSON')
    .action(async options => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }

      if (!options.name && !options.arn) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: '--name or --arn is required in non-interactive mode' }));
          process.exit(1);
        }
        // renderTUI() guards for an interactive terminal before rendering.
        await renderTUI({ initialRoute: { name: 'export-harness' }, actionOnBack: 'exit' });
        return;
      }

      const steps: string[] = [];
      let result: Awaited<ReturnType<typeof handleExportHarness>>;
      try {
        result = await handleExportHarness(options, {
          onProgress: (message: string) => {
            if (options.json) return;
            steps.push(message);
            console.log(`${green}[done]${reset}  ${message}`);
          },
        });
      } catch (err) {
        if (options.json) {
          console.log(
            JSON.stringify({ success: false, error: { message: err instanceof Error ? err.message : String(err) } })
          );
          process.exit(1);
        }
        throw err;
      }

      if (options.json) {
        console.log(JSON.stringify(serializeResult(result)));
        if (!result.success) process.exit(1);
        return;
      }

      if (!result.success) {
        console.error(`\n${red}[error]${reset} Export failed: ${result.error.message}`);
        process.exit(1);
      }

      const targetAgentName = result.agentName;
      const harnessLabel = options.name ?? options.arn;

      console.log('');
      console.log(`${green}Exported harness ${harnessLabel} → runtime agent ${targetAgentName}${reset}`);
      console.log('');
      console.log(`${dim}Generated:${reset}`);
      console.log(`  app/${targetAgentName}/    Python agent (Strands)`);
      console.log(`  agentcore/agentcore.json  updated`);
      console.log('');

      // Surface any manual follow-up notes inline so they aren't missed (also written to
      // app/<agent>/EXPORT_NOTES.md). Shared formatter keeps CLI + TUI wording in sync.
      for (const line of formatExportNotes(result.notes, `app/${targetAgentName}/EXPORT_NOTES.md`)) {
        const color = line.tone === 'warn' ? yellow : dim;
        console.log(`${color}${line.text}${reset}`);
      }
      console.log('');

      console.log('Next steps:');
      console.log('');
      console.log(`  ${cyan}agentcore deploy${reset}     ${dim}Deploy the new runtime agent${reset}`);
      console.log(`  ${cyan}agentcore dev${reset}        ${dim}Run the agent locally${reset}`);
      console.log('');
    });
}
