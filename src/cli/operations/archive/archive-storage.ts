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

/**
 * Delete the local batch eval run record for the given ID.
 * Returns true if the file existed and was deleted, false if it was not found.
 */
export function deleteLocalBatchEvalRun(batchEvaluationId: string): boolean {
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
  const filePath = join(getCliDir(), RECOMMENDATIONS_DIR, `${recommendationId}.json`);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}
