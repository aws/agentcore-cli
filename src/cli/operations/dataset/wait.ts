/**
 * Shared polling utility for dataset operations.
 * Waits until a dataset reaches ACTIVE status after an async mutation.
 */
import { getDataset } from '../../aws/agentcore-datasets';

/** Maximum time to wait for dataset to become ACTIVE (ms). */
const DEFAULT_MAX_WAIT_MS = 60_000;

/** Interval between status polls (ms). */
const POLL_INTERVAL_MS = 2_000;

/**
 * Poll GetDataset until the dataset status is ACTIVE.
 * Throws if the dataset enters a terminal failed state or the timeout expires.
 */
export async function waitForDatasetActive(
  region: string,
  datasetId: string,
  maxWaitMs = DEFAULT_MAX_WAIT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await getDataset({ region, datasetId });
    if (result.status === 'ACTIVE') return;
    if (result.status.endsWith('_FAILED')) {
      throw new Error(`Dataset entered failed state: ${result.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for dataset to become ACTIVE (waited ${maxWaitMs / 1000}s)`);
}
