import { findConfigRoot } from '../../../lib';
import { BATCH_EVAL_RESULTS_DIR } from '../eval/batch-eval-storage';
import { RECOMMENDATIONS_DIR } from '../recommendation/recommendation-storage';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

function getCliDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, '.cli');
}

function assertSafeId(id: string, label: string): void {
  if (/[/\\]/.test(id)) {
    throw new Error(`Invalid ${label}: must not contain path separators`);
  }
}

/**
 * Delete the local batch eval run record for the given ID.
 * Returns true if the file existed and was deleted, false if it was not found.
 */
export function deleteLocalBatchEvalRun(batchEvaluationId: string): boolean {
  assertSafeId(batchEvaluationId, 'batch evaluation ID');
  const filePath = join(getCliDir(), BATCH_EVAL_RESULTS_DIR, `${batchEvaluationId}.json`);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}

/**
 * Delete the local recommendation run record for the given ID.
 * Returns true if the file existed and was deleted, false if it was not found.
 */
export function deleteLocalRecommendationRun(recommendationId: string): boolean {
  assertSafeId(recommendationId, 'recommendation ID');
  const filePath = join(getCliDir(), RECOMMENDATIONS_DIR, `${recommendationId}.json`);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}
