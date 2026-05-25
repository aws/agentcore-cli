/**
 * Resolves a dataset name to its deployed state (datasetId, region, local file path).
 */
import { ConfigIO } from '../../../lib';
import type { Dataset } from '../../../schema';

export interface ResolvedDataset {
  name: string;
  datasetId: string;
  datasetArn: string;
  region: string;
  location: string;
}

/**
 * Resolve a dataset by name from the project config and deployed state.
 *
 * If `name` is undefined and there's exactly one dataset, auto-selects it.
 * If `name` is undefined and there are multiple datasets, throws with available names.
 */
export async function resolveDataset(name?: string): Promise<ResolvedDataset> {
  const configIO = new ConfigIO();
  const projectSpec = await configIO.readProjectSpec();
  const datasets: Dataset[] = projectSpec.datasets ?? [];

  if (datasets.length === 0) {
    throw new Error('No datasets found in agentcore.json. Run `agentcore add dataset` first.');
  }

  let dataset: Dataset;
  if (name) {
    const found = datasets.find(d => d.name === name);
    if (!found) {
      const available = datasets.map(d => d.name).join(', ');
      throw new Error(`Dataset "${name}" not found. Available: ${available}`);
    }
    dataset = found;
  } else if (datasets.length === 1) {
    dataset = datasets[0]!;
  } else {
    const available = datasets.map(d => d.name).join(', ');
    throw new Error(`Multiple datasets found. Specify --name. Available: ${available}`);
  }

  const targets = await configIO.resolveAWSDeploymentTargets();
  if (targets.length === 0) {
    throw new Error('No AWS deployment targets configured. Run `agentcore deploy` first.');
  }
  const region = targets[0]!.region;
  const targetName = targets[0]!.name;

  const deployedState = await configIO.readDeployedState().catch(() => undefined);
  const datasetState = deployedState?.targets?.[targetName]?.resources?.datasets?.[dataset.name];

  if (!datasetState) {
    throw new Error(`Dataset "${dataset.name}" has not been deployed. Run \`agentcore deploy\` first.`);
  }

  return {
    name: dataset.name,
    datasetId: datasetState.datasetId,
    datasetArn: datasetState.datasetArn,
    region,
    location: dataset.config.managed.location,
  };
}

/**
 * Get all dataset names from the project config.
 */
export async function getDatasetNames(): Promise<string[]> {
  const configIO = new ConfigIO();
  const projectSpec = await configIO.readProjectSpec();
  return (projectSpec.datasets ?? []).map(d => d.name);
}
