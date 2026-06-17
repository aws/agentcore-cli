import type { ABTestJobRecord } from '../../shared/types';
import { printABTestDetail } from '../format';
import { afterEach, describe, expect, it, vi } from 'vitest';

function baseRecord(overrides: Partial<ABTestJobRecord> = {}): ABTestJobRecord {
  return {
    type: 'ab-test',
    id: 'abt-123',
    arn: 'arn:aws:bedrock-agentcore:us-east-1:1:ab-test/abt-123',
    status: 'ACTIVE',
    lifecycleStatus: 'RUNNING',
    createdAt: '2026-01-01T00:00:00.000Z',
    agent: 'MyAgent',
    name: 'MyTest',
    mode: 'target-based',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:1:gateway/gw-abc',
    variants: [
      { name: 'C', weight: 50, targetName: 'ctrl' },
      { name: 'T1', weight: 50, targetName: 'treat' },
    ],
    evaluationConfig: { onlineEvaluationConfigArn: 'arn:aws:bedrock-agentcore:us-east-1:1:online-evaluation-config/q' },
    ...overrides,
  };
}

describe('printABTestDetail — gateway filter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(record: ABTestJobRecord): string {
    const spy = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    printABTestDetail(record);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    return output;
  }

  it('renders the filter path when a gatewayFilter is present', () => {
    const output = capture(baseRecord({ gatewayFilter: { targetPaths: ['/orders/*'] } }));
    expect(output).toContain('Gateway filter: /orders/*');
  });

  it('renders "none" when no gatewayFilter is present', () => {
    const output = capture(baseRecord());
    expect(output).toContain('Gateway filter: none');
  });
});
