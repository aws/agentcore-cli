import { findConfigRoot } from '../../../lib';
import type { EvaluationResults } from '../../aws/agentcore-batch-evaluation';
import type { BatchEvaluationResult, RunBatchEvaluationCommandResult } from './run-batch-evaluation';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const BATCH_EVAL_RESULTS_DIR = 'batch-eval-results';

export interface BatchEvalRunRecord {
  name: string;
  batchEvaluationId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  evaluators: string[];
  results: BatchEvaluationResult[];
  evaluationResults?: EvaluationResults;
}

function getResultsDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, '.cli', BATCH_EVAL_RESULTS_DIR);
}

export function saveBatchEvalRun(result: RunBatchEvaluationCommandResult): string {
  const dir = getResultsDir();
  mkdirSync(dir, { recursive: true });

  const id = result.batchEvaluationId ?? 'unknown';
  const filePath = join(dir, `${id}.json`);

  const record: BatchEvalRunRecord = {
    name: result.name ?? 'unknown',
    batchEvaluationId: id,
    status: result.status ?? 'unknown',
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    evaluators: result.results.map(r => r.evaluatorId),
    results: result.results,
    evaluationResults: result.evaluationResults,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadBatchEvalRun(batchEvaluationId: string): BatchEvalRunRecord {
  const dir = getResultsDir();
  const jsonName = batchEvaluationId.endsWith('.json') ? batchEvaluationId : `${batchEvaluationId}.json`;
  const filePath = join(dir, jsonName);

  if (!existsSync(filePath)) {
    throw new Error(`Batch evaluation run "${batchEvaluationId}" not found at ${filePath}`);
  }

  return JSON.parse(readFileSync(filePath, 'utf-8')) as BatchEvalRunRecord;
}

export function listBatchEvalRuns(): BatchEvalRunRecord[] {
  const dir = getResultsDir();

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as BatchEvalRunRecord);
}
