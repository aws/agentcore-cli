import { getErrorMessage } from '../../errors';
import { listEvalRuns } from './storage';
import type { EvalRunResult, ListEvalRunsOptions } from './types';

export interface ListEvalRunsResult {
  success: boolean;
  error?: string;
  runs?: EvalRunResult[];
}

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
    return { success: false, error: getErrorMessage(err) };
  }
}
