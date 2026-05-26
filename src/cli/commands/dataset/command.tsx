/**
 * Dataset management commands: download, publish-version, remove-version.
 *
 * Dataset content is synced to the service automatically during `agentcore deploy`.
 * The local JSONL file always represents the DRAFT working copy.
 */
import { ConfigIO } from '../../../lib';
import { getDataset } from '../../aws/agentcore-datasets';
import { deleteDatasetVersion, publishDataset, pullDataset, resolveDataset } from '../../operations/dataset';
import { runCliCommand } from '../../telemetry/cli-command-run.js';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';
import readline from 'node:readline';
import React from 'react';

/**
 * Prompt user for confirmation. Returns true if confirmed.
 */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(question, resolve));
  rl.close();
  return answer.toLowerCase() === 'y';
}

export function registerDataset(program: Command) {
  const datasetCmd = program.command('dataset').description('Manage dataset content and versions');

  // ══════════════════════════════════════════════════════════════════════════
  // download
  // ══════════════════════════════════════════════════════════════════════════

  datasetCmd
    .command('download')
    .description('Download dataset from service to local file')
    .option('--name <name>', 'Dataset name')
    .option('--version <version>', 'Version to pull (default: DRAFT)')
    .option('--yes', 'Skip overwrite confirmation')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { name?: string; version?: string; yes?: boolean; json?: boolean }) => {
      requireProject();

      await runCliCommand('dataset.download', !!cliOptions.json, async () => {
        const resolved = await resolveDataset(cliOptions.name);
        const configIO = new ConfigIO();
        const configBaseDir = configIO.getConfigRoot();

        if (!cliOptions.yes && !cliOptions.json) {
          const versionLabel = cliOptions.version ? `version ${cliOptions.version}` : 'DRAFT';
          console.log(`⚠ This will overwrite: ${resolved.location}`);
          console.log(`  (pulling ${versionLabel})`);

          if (!(await confirm('? Continue? (y/N) '))) {
            console.log('Skipped.');
            return {};
          }
        }

        const result = await pullDataset({
          region: resolved.region,
          datasetId: resolved.datasetId,
          localFilePath: resolved.location,
          configBaseDir,
          version: cliOptions.version,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          render(
            <Box flexDirection="column">
              <Text color="green">
                ✓ {result.exampleCount} examples written to {resolved.location}
              </Text>
              <Text dimColor> Pulled from: {result.version === 'DRAFT' ? 'DRAFT' : `version ${result.version}`}</Text>
            </Box>
          );
        }

        return {};
      });
    });

  // ══════════════════════════════════════════════════════════════════════════
  // publish-version
  // ══════════════════════════════════════════════════════════════════════════

  datasetCmd
    .command('publish-version')
    .description('Publish DRAFT as a new immutable version')
    .option('--name <name>', 'Dataset name')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { name?: string; json?: boolean }) => {
      requireProject();

      await runCliCommand('dataset.publish-version', !!cliOptions.json, async () => {
        const resolved = await resolveDataset(cliOptions.name);

        // Check draftStatus before publishing
        const info = await getDataset({ region: resolved.region, datasetId: resolved.datasetId });
        if (info.draftStatus === 'UNMODIFIED' && !cliOptions.json) {
          console.log('⚠ DRAFT has no unpublished changes (draftStatus: UNMODIFIED)');
          if (!(await confirm('? Publish anyway? (y/N) '))) {
            console.log('Skipped.');
            return {};
          }
        }

        const result = await publishDataset({
          region: resolved.region,
          datasetId: resolved.datasetId,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          render(
            <Box flexDirection="column">
              <Text color="green">
                ✓ Published version {result.version} ({result.exampleCount} examples)
              </Text>
              <Text dimColor> draftStatus: {result.draftStatus}</Text>
            </Box>
          );
        }

        return {};
      });
    });

  // ══════════════════════════════════════════════════════════════════════════
  // remove-version
  // ══════════════════════════════════════════════════════════════════════════

  datasetCmd
    .command('remove-version')
    .description('Delete a specific published version')
    .argument('<version-id>', 'Version number to remove')
    .option('--name <name>', 'Dataset name')
    .option('--json', 'Output as JSON')
    .action(async (versionId: string, cliOptions: { name?: string; json?: boolean }) => {
      requireProject();

      await runCliCommand('dataset.remove-version', !!cliOptions.json, async () => {
        const resolved = await resolveDataset(cliOptions.name);

        if (!cliOptions.json) {
          console.log(`⚠ This will permanently delete version ${versionId} of dataset "${resolved.name}".`);
          if (!(await confirm('? Continue? (y/N) '))) {
            console.log('Skipped.');
            return {};
          }
        }

        await deleteDatasetVersion({
          region: resolved.region,
          datasetId: resolved.datasetId,
          version: versionId,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, name: resolved.name, deletedVersion: versionId }));
        } else {
          render(
            <Box flexDirection="column">
              <Text color="green">
                ✓ Deleted version {versionId} of dataset &quot;{resolved.name}&quot;
              </Text>
            </Box>
          );
        }

        return {};
      });
    });

  return datasetCmd;
}
