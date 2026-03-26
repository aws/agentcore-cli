import { findConfigRoot } from '../../../lib';
import type { EvalRunResult } from './types';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const EVAL_RESULTS_DIR = 'eval-results';

function getResultsDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, '.cli', EVAL_RESULTS_DIR);
}

export function generateFilename(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `eval_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

export function saveEvalRun(result: EvalRunResult): string {
  const dir = getResultsDir();
  mkdirSync(dir, { recursive: true });

  const filename = generateFilename(result.timestamp);
  const filePath = join(dir, `${filename}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

export function loadEvalRun(filename: string): EvalRunResult {
  const dir = getResultsDir();
  const jsonName = filename.endsWith('.json') ? filename : `${filename}.json`;
  const filePath = join(dir, jsonName);

  if (!existsSync(filePath)) {
    throw new Error(`Eval run "${filename}" not found at ${filePath}`);
  }

  return JSON.parse(readFileSync(filePath, 'utf-8')) as EvalRunResult;
}

export function listEvalRuns(): EvalRunResult[] {
  const dir = getResultsDir();

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter(f => f.startsWith('eval_') && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as EvalRunResult);
}

export function getResultsPath(): string {
  return getResultsDir();
}
