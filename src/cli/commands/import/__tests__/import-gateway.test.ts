/**
 * Tests for toGatewayTargetSpec() — mcpServer target mapping and credential resolution.
 */
import type { GatewayTargetDetail } from '../../../aws/agentcore-control';
import {
  _resolveOutboundAuth as resolveOutboundAuth,
  _toGatewayTargetSpec as toGatewayTargetSpec,
} from '../import-gateway';
import { describe, expect, it, vi } from 'vitest';

// ============================================================================
// Helpers
// ============================================================================

function makeDetail(overrides: Partial<GatewayTargetDetail> = {}): GatewayTargetDetail {
  return {
    targetId: 'tgt-001',
    name: 'my-mcp-target',
    status: 'READY',
    ...overrides,
  };
}

// ============================================================================
// toGatewayTargetSpec — mcpServer mapping
// ============================================================================

describe('toGatewayTargetSpec — mcpServer targets', () => {
  it('maps mcpServer with no auth', () => {
    const detail = makeDetail({
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: 'https://example.com/mcp' },
        },
      },
    });
    const credentials = new Map<string, string>();
    const onProgress = vi.fn();

    const result = toGatewayTargetSpec(detail, credentials, onProgress);

    expect(result).toEqual({
      name: 'my-mcp-target',
      targetType: 'mcpServer',
      endpoint: 'https://example.com/mcp',
    });
    expect(result).not.toHaveProperty('outboundAuth');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('maps mcpServer with OAuth credential (resolved)', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/my-oauth';
    const detail = makeDetail({
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: 'https://example.com/mcp' },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'OAUTH',
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn,
              scopes: ['read', 'write'],
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>([[providerArn, 'my-oauth-cred']]);
    const onProgress = vi.fn();

    const result = toGatewayTargetSpec(detail, credentials, onProgress);

    expect(result).toEqual({
      name: 'my-mcp-target',
      targetType: 'mcpServer',
      endpoint: 'https://example.com/mcp',
      outboundAuth: {
        type: 'OAUTH',
        credentialName: 'my-oauth-cred',
        scopes: ['read', 'write'],
      },
    });
  });

  it('maps mcpServer with API_KEY credential (resolved)', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/my-apikey';
    const detail = makeDetail({
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: 'https://example.com/mcp' },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'API_KEY',
          credentialProvider: {
            apiKeyCredentialProvider: {
              providerArn,
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>([[providerArn, 'my-api-key-cred']]);
    const onProgress = vi.fn();

    const result = toGatewayTargetSpec(detail, credentials, onProgress);

    expect(result).toEqual({
      name: 'my-mcp-target',
      targetType: 'mcpServer',
      endpoint: 'https://example.com/mcp',
      outboundAuth: {
        type: 'API_KEY',
        credentialName: 'my-api-key-cred',
      },
    });
  });

  it('throws when OAuth credential not found in project', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/missing-oauth';
    const detail = makeDetail({
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: 'https://example.com/mcp' },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'OAUTH',
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn,
              scopes: ['read'],
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>();
    const onProgress = vi.fn();

    expect(() => toGatewayTargetSpec(detail, credentials, onProgress)).toThrow(
      'uses an OAuth credential provider not found'
    );
  });

  it('throws when API_KEY credential not found in project', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/missing-apikey';
    const detail = makeDetail({
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: 'https://example.com/mcp' },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'API_KEY',
          credentialProvider: {
            apiKeyCredentialProvider: {
              providerArn,
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>();
    const onProgress = vi.fn();

    expect(() => toGatewayTargetSpec(detail, credentials, onProgress)).toThrow(
      'uses an API Key credential provider not found'
    );
  });

  it('returns undefined and warns when target has no MCP configuration', () => {
    const detail = makeDetail({
      targetConfiguration: undefined,
    });
    const credentials = new Map<string, string>();
    const onProgress = vi.fn();

    const result = toGatewayTargetSpec(detail, credentials, onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('no MCP configuration'));
  });
});

// ============================================================================
// resolveOutboundAuth — OAuth scopes handling
// ============================================================================

describe('resolveOutboundAuth — scopes handling', () => {
  it('includes scopes when OAuth provider has non-empty scopes array', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/oauth-scoped';
    const detail = makeDetail({
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'OAUTH',
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn,
              scopes: ['openid', 'profile', 'email'],
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>([[providerArn, 'scoped-cred']]);
    const onProgress = vi.fn();

    const result = resolveOutboundAuth(detail, credentials, onProgress);

    expect(result).toEqual({
      type: 'OAUTH',
      credentialName: 'scoped-cred',
      scopes: ['openid', 'profile', 'email'],
    });
  });

  it('omits scopes when OAuth provider has empty scopes array', () => {
    const providerArn = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/oauth-no-scope';
    const detail = makeDetail({
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'OAUTH',
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn,
              scopes: [],
            },
          },
        },
      ],
    });
    const credentials = new Map<string, string>([[providerArn, 'no-scope-cred']]);
    const onProgress = vi.fn();

    const result = resolveOutboundAuth(detail, credentials, onProgress);

    expect(result).toEqual({
      type: 'OAUTH',
      credentialName: 'no-scope-cred',
    });
    expect(result).not.toHaveProperty('scopes');
  });
});
