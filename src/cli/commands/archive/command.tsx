import { deleteBatchEvaluation } from '../../aws/agentcore-batch-evaluation';
import { deleteRecommendation } from '../../aws/agentcore-recommendation';
import { getErrorMessage } from '../../errors';
import { deleteLocalBatchEvalRun, deleteLocalRecommendationRun } from '../../operations/archive/archive-storage';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { getRegion } from '../shared/region-utils';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

async function executeArchive<T extends { status: string }>(
  cliOptions: { id: string; region?: string; json?: boolean },
  config: {
    serviceDelete: (id: string, region: string) => Promise<T>;
    localDelete: (id: string) => boolean;
    getId: (result: T) => string;
    successMessage: string;
  }
): Promise<void> {
  requireProject();
  try {
    const region = await getRegion(cliOptions.region);
    const result = await config.serviceDelete(cliOptions.id, region);

    let localCliHistoryDeleted = false;
    let localDeleteWarning: string | undefined;
    try {
      localCliHistoryDeleted = config.localDelete(cliOptions.id);
    } catch (err) {
      localDeleteWarning = getErrorMessage(err);
    }

    if (cliOptions.json) {
      console.log(
        JSON.stringify({
          success: true,
          ...result,
          localCliHistoryDeleted,
          ...(localDeleteWarning && { localDeleteWarning }),
        })
      );
    } else {
      console.log(`\n${config.successMessage}`);
      console.log(`ID: ${config.getId(result)}`);
      console.log(`Status: ${result.status}`);
      if (localCliHistoryDeleted) console.log(`Local history cleared.`);
      if (localDeleteWarning) console.log(`Warning: could not clear local history: ${localDeleteWarning}`);
      console.log('');
    }
  } catch (error) {
    if (cliOptions.json) {
      console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
    } else {
      render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
    }
    process.exit(1);
  }
}

export const registerArchive = (program: Command) => {
  const archiveCmd = program.command('archive').description(COMMAND_DESCRIPTIONS.archive);

  archiveCmd
    .command('batch-evaluation')
    .description('[preview] Archive (delete) a batch evaluation on the service and clear local history')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive(cliOptions, {
        serviceDelete: (id, region) => deleteBatchEvaluation({ region, batchEvaluationId: id }),
        localDelete: deleteLocalBatchEvalRun,
        getId: result => result.batchEvaluationId,
        successMessage: 'Batch evaluation archived successfully',
      })
    );

  archiveCmd
    .command('recommendation')
    .description('[preview] Archive (delete) a recommendation on the service and clear local history')
    .requiredOption('-i, --id <id>', 'Recommendation ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive(cliOptions, {
        serviceDelete: (id, region) => deleteRecommendation({ region, recommendationId: id }),
        localDelete: deleteLocalRecommendationRun,
        getId: result => result.recommendationId,
        successMessage: 'Recommendation archived successfully',
      })
    );
};
