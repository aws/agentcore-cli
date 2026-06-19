import { computeInvokeAttrs } from '../utils';
import { describe, expect, it } from 'vitest';

describe('computeInvokeAttrs', () => {
  it('returns harness when harnessName is set', () => {
    const attrs = computeInvokeAttrs({
      harnessName: 'my-harness',
      harnessCount: 1,
      runtimeCount: 1,
      stream: false,
      hasSessionId: true,
    });
    expect(attrs.agent_environment).toBe('harness');
    expect(attrs.agent_protocol).toBeUndefined();
    expect(attrs.has_session_id).toBe(true);
  });

  it('returns harness when harnessArn is set', () => {
    const attrs = computeInvokeAttrs({
      harnessArn: 'arn:aws:bedrock:us-east-1:123:harness/h1',
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
    });
    expect(attrs.agent_environment).toBe('harness');
    expect(attrs.agent_protocol).toBeUndefined();
  });

  it('returns harness when project has only harnesses', () => {
    const attrs = computeInvokeAttrs({
      harnessCount: 2,
      runtimeCount: 0,
      stream: false,
      hasSessionId: false,
    });
    expect(attrs.agent_environment).toBe('harness');
  });

  it('returns runtime for mixed project without explicit harness flag', () => {
    const attrs = computeInvokeAttrs({
      harnessCount: 1,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
    });
    expect(attrs.agent_environment).toBe('runtime');
    expect(attrs.agent_protocol).toBe('http');
  });

  it('passes auth_type based on bearerToken', () => {
    const withToken = computeInvokeAttrs({
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
      bearerToken: 'tok',
    });
    expect(withToken.auth_type).toBe('bearer_token');

    const withoutToken = computeInvokeAttrs({
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
    });
    expect(withoutToken.auth_type).toBe('sigv4');
  });

  it('uses provided agentProtocol for runtime', () => {
    const attrs = computeInvokeAttrs({
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
      agentProtocol: 'MCP',
    });
    expect(attrs.agent_protocol).toBe('mcp');
  });
});
