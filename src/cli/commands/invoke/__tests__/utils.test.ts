import { computeInvokeAttrs } from '../utils';
import { describe, expect, it } from 'vitest';

describe('computeInvokeAttrs', () => {
  it('returns runtime when preview is false regardless of harness flags', () => {
    const attrs = computeInvokeAttrs({
      preview: false,
      harnessName: 'my-harness',
      harnessCount: 1,
      runtimeCount: 0,
      stream: true,
      hasSessionId: false,
    });
    expect(attrs.agent_environment).toBe('runtime');
    expect(attrs.agent_protocol).toBe('http');
  });

  it('returns harness when harnessName is set and preview is true', () => {
    const attrs = computeInvokeAttrs({
      preview: true,
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

  it('returns harness when harnessArn is set and preview is true', () => {
    const attrs = computeInvokeAttrs({
      preview: true,
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
      preview: true,
      harnessCount: 2,
      runtimeCount: 0,
      stream: false,
      hasSessionId: false,
    });
    expect(attrs.agent_environment).toBe('harness');
  });

  it('returns runtime for mixed project without explicit harness flag', () => {
    const attrs = computeInvokeAttrs({
      preview: true,
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
      preview: false,
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
      bearerToken: 'tok',
    });
    expect(withToken.auth_type).toBe('bearer_token');

    const withoutToken = computeInvokeAttrs({
      preview: false,
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
    });
    expect(withoutToken.auth_type).toBe('sigv4');
  });

  it('uses provided agentProtocol for runtime', () => {
    const attrs = computeInvokeAttrs({
      preview: false,
      harnessCount: 0,
      runtimeCount: 1,
      stream: false,
      hasSessionId: false,
      agentProtocol: 'MCP',
    });
    expect(attrs.agent_protocol).toBe('mcp');
  });
});
