import { NOT_FOUND_STATUS, isTerminal } from '../constants';
import type { ABTestJobRecord, BatchEvaluationJobRecord, RecommendationJobRecord } from '../types';
import { describe, expect, it } from 'vitest';

function rec(status: string): RecommendationJobRecord {
  return {
    type: 'recommendation',
    id: 'rec-1',
    arn: 'arn',
    status,
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    recommendationType: 'SYSTEM_PROMPT_RECOMMENDATION',
    evaluators: [],
    inputSource: 'inline',
  };
}

function batch(status: string, resultsFetched?: boolean): BatchEvaluationJobRecord {
  return {
    type: 'batch-evaluation',
    id: 'be-1',
    arn: 'arn',
    status,
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    name: 'n',
    evaluators: [],
    resultsFetched,
  };
}

/** status = lifecycle (ACTIVE/FAILED/CREATE_FAILED), lifecycleStatus = executionStatus (RUNNING/PAUSED/STOPPED) */
function abTest(status: string, lifecycleStatus = 'RUNNING'): ABTestJobRecord {
  return {
    type: 'ab-test',
    id: 'abt-1',
    arn: 'arn',
    status,
    lifecycleStatus,
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    name: 'n',
    mode: 'config-bundle',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:1:gateway/g',
    variants: [],
    evaluationConfig: { onlineEvaluationConfigArn: 'arn' },
  };
}

describe('isTerminal', () => {
  it('treats recommendation COMPLETED/FAILED/NOT_FOUND as terminal', () => {
    expect(isTerminal(rec('COMPLETED'))).toBe(true);
    expect(isTerminal(rec('FAILED'))).toBe(true);
    expect(isTerminal(rec(NOT_FOUND_STATUS))).toBe(true);
  });

  it('treats recommendation PENDING/IN_PROGRESS as non-terminal', () => {
    expect(isTerminal(rec('PENDING'))).toBe(false);
    expect(isTerminal(rec('IN_PROGRESS'))).toBe(false);
  });

  it('keeps a terminal-status batch eval refreshable until results are fetched', () => {
    expect(isTerminal(batch('COMPLETED', false))).toBe(false); // results not fetched yet → still refreshable
    expect(isTerminal(batch('COMPLETED', true))).toBe(true);
  });

  it('treats batch NOT_FOUND as terminal regardless of resultsFetched', () => {
    expect(isTerminal(batch(NOT_FOUND_STATUS, false))).toBe(true);
  });

  it('treats unknown statuses as non-terminal', () => {
    expect(isTerminal(rec('SOMETHING_NEW'))).toBe(false);
    expect(isTerminal(batch('STOPPING', true))).toBe(false);
  });

  it('treats ab-test as terminal when failed + failureReason captured, or NOT_FOUND', () => {
    expect(isTerminal({ ...abTest('FAILED'), failureReason: 'infra error' })).toBe(true);
    expect(isTerminal({ ...abTest('CREATE_FAILED'), failureReason: 'setup error' })).toBe(true);
    expect(isTerminal({ ...abTest('UPDATE_FAILED'), failureReason: 'update error' })).toBe(true);
    expect(isTerminal(abTest(NOT_FOUND_STATUS))).toBe(true);
  });

  it('keeps ab-test refreshable when failed but failureReason not yet captured', () => {
    expect(isTerminal(abTest('FAILED'))).toBe(false);
    expect(isTerminal(abTest('CREATE_FAILED'))).toBe(false);
  });

  it('treats ab-test ACTIVE/CREATING as non-terminal', () => {
    expect(isTerminal(abTest('ACTIVE'))).toBe(false);
    expect(isTerminal(abTest('CREATING'))).toBe(false);
  });
});
