import { deleteDatasetVersionApi } from '../../aws/agentcore-datasets';

export interface DeleteDatasetVersionOptions {
  region: string;
  datasetId: string;
  version: string;
}

export async function deleteDatasetVersion(options: DeleteDatasetVersionOptions): Promise<void> {
  const { region, datasetId, version } = options;
  await deleteDatasetVersionApi({ region, datasetId, version });
}
