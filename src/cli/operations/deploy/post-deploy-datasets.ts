import type { Dataset, DatasetDeployedState } from '../../../schema';
import { pushDataset } from '../dataset';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SyncDatasetsOptions {
  region: string;
  datasets: Dataset[];
  deployedDatasets: Record<string, DatasetDeployedState>;
  configBaseDir: string;
}

export interface SyncDatasetsResult {
  hasErrors: boolean;
  results: DatasetSyncResultEntry[];
  updatedDatasets: Record<string, DatasetDeployedState>;
}

export interface DatasetSyncResultEntry {
  datasetName: string;
  status: 'synced' | 'skipped' | 'error';
  added?: number;
  updated?: number;
  deleted?: number;
  error?: string;
}

function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function syncDatasets(options: SyncDatasetsOptions): Promise<SyncDatasetsResult> {
  const { region, datasets, deployedDatasets, configBaseDir } = options;
  const results: DatasetSyncResultEntry[] = [];
  const updatedDatasets = { ...deployedDatasets };

  for (const dataset of datasets) {
    const state = deployedDatasets[dataset.name];
    if (!state) continue;

    try {
      const localFilePath = dataset.config.managed.location;
      const absolutePath = resolve(configBaseDir, localFilePath);
      const localContent = await readFile(absolutePath, 'utf8');
      const currentHash = computeFileHash(localContent);

      if (state.contentHash === currentHash) {
        results.push({ datasetName: dataset.name, status: 'skipped' });
        continue;
      }

      const pushResult = await pushDataset({
        region,
        datasetId: state.datasetId,
        localFilePath,
        configBaseDir,
      });

      // Re-read the file after push because pushDataset rewrites it with new exampleIds.
      // The hash must reflect the actual on-disk content so subsequent deploys can skip unchanged datasets.
      const postPushContent = await readFile(absolutePath, 'utf8');
      const postPushHash = computeFileHash(postPushContent);

      updatedDatasets[dataset.name] = {
        ...state,
        contentHash: postPushHash,
      };

      results.push({
        datasetName: dataset.name,
        status: 'synced',
        added: pushResult.added,
        updated: pushResult.updated,
        deleted: pushResult.deleted,
      });
    } catch (err) {
      results.push({
        datasetName: dataset.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    hasErrors: results.some(r => r.status === 'error'),
    results,
    updatedDatasets,
  };
}
