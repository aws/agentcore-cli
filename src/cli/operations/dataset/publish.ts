/**
 * Publish dataset DRAFT as a new immutable version.
 */
import { createDatasetVersion, getDataset } from '../../aws/agentcore-datasets';
import { waitForDatasetActive } from './wait';

export interface PublishOptions {
  region: string;
  datasetId: string;
}

export interface PublishResult {
  version: string;
  exampleCount: number;
  draftStatus: string;
}

/**
 * Publish the current DRAFT as a new numbered version.
 * Polls until the dataset returns to ACTIVE state.
 */
export async function publishDataset(options: PublishOptions): Promise<PublishResult> {
  const { region, datasetId } = options;

  const versionResult = await createDatasetVersion({ region, datasetId });

  await waitForDatasetActive(region, datasetId);

  // Re-fetch to get final state after publish
  const info = await getDataset({ region, datasetId });

  return {
    version: versionResult.datasetVersion,
    exampleCount: info.exampleCount,
    draftStatus: info.draftStatus ?? 'UNMODIFIED',
  };
}
