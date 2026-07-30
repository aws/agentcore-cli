import type { ABTestJobRecord } from '../../shared/types';
import { getInvocationUrl, getInvocationUrlCandidates, printABTestDetail } from '../format';
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

const GW_BASE = 'https://gw-abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com';

const cfgBundle = (overrides: Partial<ABTestJobRecord> = {}) =>
  baseRecord({ mode: 'config-bundle', agent: 'CustomerSupportAB', variants: [], ...overrides });

describe('getInvocationUrl', () => {
  it('target-based: builds a full invocation URL from the control target name', () => {
    expect(getInvocationUrl(baseRecord())).toBe(`${GW_BASE}/ctrl/invocations`);
  });

  it('target-based: returns undefined when the control target name is missing', () => {
    expect(getInvocationUrl(baseRecord({ variants: [] }))).toBeUndefined();
  });

  it('config-bundle: builds a full URL from the target resolved at create time', () => {
    expect(getInvocationUrl(cfgBundle({ targetName: 'customer-support-ab' }))).toBe(
      `${GW_BASE}/customer-support-ab/invocations`
    );
  });

  // Regression for #1854: `agent` holds the RUNTIME name, which is not a valid gateway path segment.
  // With no resolved target, no complete URL is emitted (candidates / base URL cover those cases).
  it('config-bundle: returns undefined when no single target resolved (never the runtime name)', () => {
    expect(getInvocationUrl(cfgBundle())).toBeUndefined();
    expect(getInvocationUrl(cfgBundle({ targetCandidates: ['a', 'b'] }))).toBeUndefined();
  });

  it('returns undefined for a gateway ARN it cannot parse', () => {
    expect(getInvocationUrl(baseRecord({ gatewayArn: 'not-an-arn' }))).toBeUndefined();
  });
});

describe('getInvocationUrlCandidates', () => {
  it('builds one URL per candidate target', () => {
    expect(getInvocationUrlCandidates(cfgBundle({ targetCandidates: ['prod', 'canary'] }))).toEqual([
      `${GW_BASE}/prod/invocations`,
      `${GW_BASE}/canary/invocations`,
    ]);
  });

  it('is empty when a single target resolved or none did', () => {
    expect(getInvocationUrlCandidates(cfgBundle({ targetName: 'only' }))).toEqual([]);
    expect(getInvocationUrlCandidates(cfgBundle())).toEqual([]);
  });
});

describe('printABTestDetail — invocation URL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(record: ABTestJobRecord): string {
    const spy = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    printABTestDetail(record);
    return spy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  it('prints a complete invocation URL for target-based tests', () => {
    expect(capture(baseRecord())).toContain(`Invocation URL: ${GW_BASE}/ctrl/invocations`);
  });

  it('prints a complete invocation URL when a config-bundle target uniquely resolved', () => {
    const output = capture(cfgBundle({ targetName: 'customer-support-ab' }));
    expect(output).toContain(`Invocation URL: ${GW_BASE}/customer-support-ab/invocations`);
  });

  it('lists candidate URLs when several targets front the runtime', () => {
    const output = capture(cfgBundle({ targetCandidates: ['prod', 'canary'] }));
    expect(output).toContain(`${GW_BASE}/prod/invocations`);
    expect(output).toContain(`${GW_BASE}/canary/invocations`);
  });

  it('falls back to the gateway URL and hint when no target could be resolved', () => {
    const output = capture(cfgBundle());
    expect(output).toContain(`Gateway URL: ${GW_BASE}`);
    expect(output).toContain('append /<gateway-target>/invocations');
    expect(output).not.toContain('CustomerSupportAB');
  });
});
