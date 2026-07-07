import type { HarnessSpec } from '../../../../schema';
import { handleAddTool } from '../tool-action.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadHarnessSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();
const mockReadDeployedState = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readHarnessSpec = mockReadHarnessSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
    readDeployedState = mockReadDeployedState;
  },
}));

function makeHarnessSpec(overrides: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    name: 'TestHarness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' },
    tools: [],
    skills: [],
    ...overrides,
  } as HarnessSpec;
}

describe('handleAddTool — gateway resolution', () => {
  beforeEach(() => {
    mockReadHarnessSpec.mockReset();
    mockWriteHarnessSpec.mockReset();
    mockReadDeployedState.mockReset();
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('resolves an MCP gateway stored under resources.mcp.gateways', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            mcp: {
              gateways: {
                'my-gateway': {
                  gatewayId: 'mcp-gw-id',
                  gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/mcp-gw-id',
                },
              },
            },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'my-gateway',
      outboundAuth: 'awsIam',
    });

    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            type: 'agentcore_gateway',
            name: 'my-tool',
            config: {
              agentCoreGateway: {
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/mcp-gw-id',
                outboundAuth: { awsIam: {} },
              },
            },
          }),
        ],
      })
    );
  });

  it('resolves an HTTP gateway stored under resources.gateways (not under mcp)', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            gateways: {
              'my-gateway': {
                gatewayId: 'http-gw-id',
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/http-gw-id',
              },
            },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'my-gateway',
      outboundAuth: 'none',
    });

    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            config: {
              agentCoreGateway: {
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/http-gw-id',
                outboundAuth: { none: {} },
              },
            },
          }),
        ],
      })
    );
  });

  it('resolves a gateway from a non-first target', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        staging: { resources: {} },
        production: {
          resources: {
            gateways: {
              'my-gateway': {
                gatewayId: 'prod-gw-id',
                gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/prod-gw-id',
              },
            },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'my-gateway',
      outboundAuth: 'awsIam',
    });

    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            config: {
              agentCoreGateway: {
                gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/prod-gw-id',
                outboundAuth: { awsIam: {} },
              },
            },
          }),
        ],
      })
    );
  });

  it('finds gateway when both MCP and HTTP gateways coexist', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            mcp: {
              gateways: {
                'mcp-gw': { gatewayId: 'mcp-id', gatewayArn: 'arn:mcp' },
              },
            },
            gateways: {
              'http-gw': { gatewayId: 'http-id', gatewayArn: 'arn:http' },
            },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'http-gw',
      outboundAuth: 'awsIam',
    });

    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            config: { agentCoreGateway: { gatewayArn: 'arn:http', outboundAuth: { awsIam: {} } } },
          }),
        ],
      })
    );
  });

  it('returns error when gateway name is not found in any location', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            mcp: { gateways: { 'other-gw': { gatewayId: 'x', gatewayArn: 'arn:x' } } },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Gateway 'nonexistent' not found in deployed state");
  });

  it('returns error when deployed state cannot be read', async () => {
    mockReadDeployedState.mockRejectedValue(new Error('File not found'));

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'my-gateway',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not read deployed state');
  });

  it('skips gateway resolution when --gateway-arn is provided directly', async () => {
    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/direct-arn',
      outboundAuth: 'awsIam',
    });

    expect(result.success).toBe(true);
    expect(mockReadDeployedState).not.toHaveBeenCalled();
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            config: {
              agentCoreGateway: {
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/direct-arn',
                outboundAuth: { awsIam: {} },
              },
            },
          }),
        ],
      })
    );
  });

  it('resolves gateway with oauth outbound auth', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            gateways: {
              'my-gateway': {
                gatewayId: 'gw-id',
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw-id',
              },
            },
          },
        },
      },
    });

    const result = await handleAddTool({
      harness: 'TestHarness',
      type: 'agentcore_gateway',
      name: 'my-tool',
      gateway: 'my-gateway',
      outboundAuth: 'oauth',
      providerArn:
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/my-cred',
      scopes: 'openid,profile',
      grantType: 'CLIENT_CREDENTIALS',
    });

    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            config: {
              agentCoreGateway: {
                gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw-id',
                outboundAuth: {
                  oauth: {
                    providerArn:
                      'arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/my-cred',
                    scopes: ['openid', 'profile'],
                    grantType: 'CLIENT_CREDENTIALS',
                  },
                },
              },
            },
          }),
        ],
      })
    );
  });
});
