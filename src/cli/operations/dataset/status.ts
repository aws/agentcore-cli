/**
 * Get dataset status — DRAFT info and version history.
 */
import { getDataset, listDatasetVersions } from '../../aws/agentcore-datasets';
import type { DatasetVersionSummary } from '../../aws/agentcore-datasets';

export interface StatusOptions {
  region: string;
  datasetId: string;
  name: string;
}

export interface DatasetStatusResult {
  name: string;
  datasetId: string;
  schemaType: string;
  status: string;
  draftExampleCount: number;
  draftStatus: string;
  updatedAt: number;
  versions: DatasetVersionSummary[];
}

/**
 * Get dataset status combining DRAFT info and version history.
 */
export async function getDatasetStatus(options: StatusOptions): Promise<DatasetStatusResult> {
  const { region, datasetId, name } = options;

  const [datasetInfo, versionsInfo] = await Promise.all([
    getDataset({ region, datasetId }),
    listDatasetVersions({ region, datasetId }),
  ]);

  return {
    name,
    datasetId,
    schemaType: datasetInfo.schemaType,
    status: datasetInfo.status,
    draftExampleCount: datasetInfo.exampleCount,
    draftStatus: datasetInfo.draftStatus ?? 'UNKNOWN',
    updatedAt: datasetInfo.updatedAt,
    versions: versionsInfo.versions,
  };
}
