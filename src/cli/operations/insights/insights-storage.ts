import { findConfigRoot } from '../../../lib';
import type { InsightsRunRecord } from './types';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

export const INSIGHTS_DIR = 'insights';

function getInsightsDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, '.cli', INSIGHTS_DIR);
}

export function saveInsightsRun(record: InsightsRunRecord): string {
  const dir = getInsightsDir();
  mkdirSync(dir, { recursive: true });
  const id = record.batchEvaluationId;
  const filePath = join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadInsightsRun(batchEvaluationId: string): InsightsRunRecord {
  const dir = getInsightsDir();
  const jsonName = batchEvaluationId.endsWith('.json') ? batchEvaluationId : `${batchEvaluationId}.json`;
  const filePath = join(dir, jsonName);
  if (!existsSync(filePath)) {
    throw new Error(`Insights run "${batchEvaluationId}" not found at ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as InsightsRunRecord;
}

export function listInsightsRuns(): InsightsRunRecord[] {
  const dir = getInsightsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as InsightsRunRecord);
}

export function deleteLocalInsightsRun(batchEvaluationId: string): boolean {
  const dir = getInsightsDir();
  const filePath = join(dir, `${batchEvaluationId}.json`);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}

export function updateInsightsRun(batchEvaluationId: string, updates: Partial<InsightsRunRecord>): void {
  const record = loadInsightsRun(batchEvaluationId);
  const updated: InsightsRunRecord = { ...record, ...updates };
  const dir = getInsightsDir();
  writeFileSync(join(dir, `${batchEvaluationId}.json`), JSON.stringify(updated, null, 2));
}
