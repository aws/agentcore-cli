/**
 * Pull dataset content from service to local file.
 *
 * Uses streaming download to avoid memory pressure on large datasets.
 */
import { downloadDataset, getDataset } from '../../aws/agentcore-datasets';
import { resolve } from 'node:path';

export interface PullOptions {
  region: string;
  datasetId: string;
  localFilePath: string;
  configBaseDir: string;
  version?: string;
}

export interface PullResult {
  exampleCount: number;
  version: string;
}

/**
 * Pull dataset content from the service and stream to local file.
 */
export async function pullDataset(options: PullOptions): Promise<PullResult> {
  const { region, datasetId, localFilePath, configBaseDir, version } = options;
  const absolutePath = resolve(configBaseDir, localFilePath);

  const datasetInfo = await getDataset({ region, datasetId, version });

  if (datasetInfo.status !== 'ACTIVE') {
    throw new Error(`Dataset is not ready (status: ${datasetInfo.status}). Please try again later.`);
  }

  if (!datasetInfo.downloadUrl) {
    throw new Error('Dataset has no download URL available. The dataset may not be ready yet. Please try again later.');
  }

  // Stream directly to file — avoids holding full content in memory
  const lineCount = await downloadDataset(datasetInfo.downloadUrl, { mode: 'stream', filePath: absolutePath });

  return {
    exampleCount: lineCount,
    version: datasetInfo.datasetVersion,
  };
}
