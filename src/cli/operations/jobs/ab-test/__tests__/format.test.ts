import type { ABTestJobRecord } from '../../shared/types';
import { getInvocationUrl, isGatewayBaseUrl, printABTestDetail } from '../format';
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

describe('getInvocationUrl', () => {
  it('target-based: builds a full invocation URL from the control target name', () => {
    expect(getInvocationUrl(baseRecord())).toBe(`${GW_BASE}/ctrl/invocations`);
    expect(isGatewayBaseUrl(baseRecord())).toBe(false);
  });

  it('target-based: returns undefined when the control target name is missing', () => {
    expect(getInvocationUrl(baseRecord({ variants: [] }))).toBeUndefined();
  });

  // Regression for #1854: `agent` holds the RUNTIME name, which is not a valid gateway path segment.
  // Emitting it produced URLs failing with "No Target found for Target name: <runtime>".
  it('config-bundle: returns the gateway base URL, never the runtime name as a path', () => {
    const record = baseRecord({ mode: 'config-bundle', agent: 'CustomerSupportAB', variants: [] });
    expect(getInvocationUrl(record)).toBe(GW_BASE);
    expect(getInvocationUrl(record)).not.toContain('CustomerSupportAB');
    expect(isGatewayBaseUrl(record)).toBe(true);
  });

  it('returns undefined for a gateway ARN it cannot parse', () => {
    expect(getInvocationUrl(baseRecord({ gatewayArn: 'not-an-arn' }))).toBeUndefined();
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

  it('labels a target-based URL as the invocation URL', () => {
    const output = capture(baseRecord());
    expect(output).toContain(`Invocation URL: ${GW_BASE}/ctrl/invocations`);
  });

  it('labels a config-bundle URL as the gateway URL and hints at the missing path', () => {
    const output = capture(baseRecord({ mode: 'config-bundle', agent: 'CustomerSupportAB', variants: [] }));
    expect(output).toContain(`Gateway URL: ${GW_BASE}`);
    expect(output).toContain('append /<gateway-target>/invocations');
    expect(output).not.toContain('Invocation URL:');
  });
});
