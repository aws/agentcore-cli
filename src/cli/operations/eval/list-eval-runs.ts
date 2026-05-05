import { toError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { listEvalRuns } from './storage';
import type { EvalRunResult, ListEvalRunsOptions } from './types';

export type ListEvalRunsResult = Result<{ runs: EvalRunResult[] }>;

export function handleListEvalRuns(options: ListEvalRunsOptions): ListEvalRunsResult {
  try {
    let runs = listEvalRuns();

    if (options.agent) {
      runs = runs.filter(r => r.agent === options.agent);
    }

    if (options.limit) {
      runs = runs.slice(0, options.limit);
    }

    return { success: true, runs };
  } catch (err) {
    return { success: false, error: toError(err) };
  }
}
