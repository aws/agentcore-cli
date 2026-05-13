import { findConfigRoot } from '../../../lib';
import type { RecommendationResult, RecommendationType } from '../../aws/agentcore-recommendation';
import type { RunRecommendationCommandResult } from './types';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const RECOMMENDATIONS_DIR = 'recommendations';

export interface RecommendationRunRecord {
  recommendationId: string;
  type: RecommendationType;
  agent: string;
  evaluators: string[];
  status: string;
  startedAt?: string;
  completedAt?: string;
  result?: RecommendationResult;
}

function getRecommendationResultsDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, '.cli', RECOMMENDATIONS_DIR);
}

export function saveRecommendationRun(
  recommendationId: string,
  result: RunRecommendationCommandResult,
  type: RecommendationType,
  agent: string,
  evaluators: string[]
): string {
  const dir = getRecommendationResultsDir();
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${recommendationId}.json`);

  const record: RecommendationRunRecord = {
    recommendationId,
    type,
    agent,
    evaluators,
    status: result.status ?? 'unknown',
    startedAt: result.success ? result.startedAt : undefined,
    completedAt: result.success ? result.completedAt : undefined,
    result: result.success ? result.result : undefined,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadRecommendationRun(recommendationId: string): RecommendationRunRecord {
  const dir = getRecommendationResultsDir();
  const jsonName = recommendationId.endsWith('.json') ? recommendationId : `${recommendationId}.json`;
  const filePath = join(dir, jsonName);

  if (!existsSync(filePath)) {
    throw new Error(`Recommendation "${recommendationId}" not found at ${filePath}`);
  }

  return JSON.parse(readFileSync(filePath, 'utf-8')) as RecommendationRunRecord;
}

export function listAllRecommendations(): RecommendationRunRecord[] {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }

  const dir = join(configRoot, '.cli', RECOMMENDATIONS_DIR);
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as RecommendationRunRecord);
}
