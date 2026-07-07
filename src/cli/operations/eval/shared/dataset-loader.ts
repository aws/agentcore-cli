/**
 * Load and validate dataset scenarios for evaluation.
 *
 * Supports two modes:
 * - Local file (no --version): reads directly from config.managed.location
 * - Version mode (--version N or DRAFT): downloads from service via pre-signed URL
 */
import { downloadDataset, getDataset } from '../../../aws/agentcore-datasets';
import { resolveDataset } from '../../dataset/resolve-dataset';
import type { PredefinedScenario, Turn } from './types';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface LoadDatasetOptions {
  datasetName: string;
  version?: string;
  configBaseDir: string;
}

/**
 * Load dataset scenarios from local file or service version.
 * Validates required fields and rejects simulated schemas.
 */
export async function loadDatasetScenarios(options: LoadDatasetOptions): Promise<PredefinedScenario[]> {
  const { datasetName, version, configBaseDir } = options;
  const resolved = await resolveDataset(datasetName);

  // Check schema type — reject simulated
  const { ConfigIO } = await import('../../../../lib');
  const configIO = new ConfigIO();
  const projectSpec = await configIO.readProjectSpec();
  const datasetSpec = projectSpec.datasets?.find(d => d.name === datasetName);
  if (datasetSpec?.schemaType === 'AGENTCORE_EVALUATION_SIMULATED_V1') {
    throw new Error(
      'Simulated scenarios (actor profiles) are not supported yet. Use predefined turns or wait for Phase 4.'
    );
  }

  let content: string;

  if (!version) {
    // Local file mode — read directly (fastest iteration, no push required)
    const filePath = resolve(configBaseDir, resolved.location);
    content = await readFile(filePath, 'utf8');
  } else {
    // Version mode — download from service
    const datasetInfo = await getDataset({
      region: resolved.region,
      datasetId: resolved.datasetId,
      version: version === 'DRAFT' ? undefined : version,
    });
    if (!datasetInfo.downloadUrl) {
      throw new Error(
        'Dataset has no download URL available. The dataset may not be ready yet. Please try again later.'
      );
    }
    content = await downloadDataset(datasetInfo.downloadUrl, { mode: 'buffer' });
  }

  return parseAndValidate(content);
}

/**
 * Parse JSONL content into validated PredefinedScenario objects.
 */
function parseAndValidate(content: string): PredefinedScenario[] {
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    throw new Error('Dataset has no examples. Add scenarios to your dataset file first.');
  }

  return lines.map((line, index) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Invalid JSON at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}\n` +
          `  ${line.length > 120 ? line.slice(0, 120) + '...' : line}`
      );
    }

    if (!obj.scenario_id || typeof obj.scenario_id !== 'string') {
      throw new Error(`Line ${index + 1}: missing required field "scenario_id"`);
    }

    if (!obj.turns || !Array.isArray(obj.turns) || obj.turns.length === 0) {
      throw new Error(`Line ${index + 1}: "turns" must be a non-empty array`);
    }

    for (let i = 0; i < (obj.turns as unknown[]).length; i++) {
      const turn = (obj.turns as Record<string, unknown>[])[i];
      if (!turn?.input || typeof turn.input !== 'string') {
        throw new Error(`Line ${index + 1}, turn ${i + 1}: each turn must have a string "input" field`);
      }
    }

    return {
      scenario_id: obj.scenario_id,
      turns: obj.turns as Turn[],
      assertions: obj.assertions as string[] | undefined,
      expected_trajectory: obj.expected_trajectory as string[] | undefined,
    };
  });
}
