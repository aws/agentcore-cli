import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadDeployedState, mockReadMcpSpec, mockConfigExists } = vi.hoisted(() => ({
  mockReadDeployedState: vi.fn(),
  mockReadMcpSpec: vi.fn(),
  mockConfigExists: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readDeployedState = mockReadDeployedState;
    readMcpSpec = mockReadMcpSpec;
    configExists = mockConfigExists;
  },
}));

const { getGatewayEnvVars } = await import('../gateway-env.js');

describe('getGatewayEnvVars', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty when no deployed state', async () => {
    mockReadDeployedState.mockRejectedValue(new Error('not found'));
    const result = await getGatewayEnvVars();
    expect(result).toEqual({});
  });

  it('returns empty when no gateways deployed', async () => {
    mockReadDeployedState.mockResolvedValue({ targets: {} });
    mockConfigExists.mockReturnValue(false);
    const result = await getGatewayEnvVars();
    expect(result).toEqual({});
  });

  it('generates URL and AUTH_TYPE env vars for deployed gateway', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            mcp: {
              gateways: {
                'my-gateway': { gatewayUrl: 'https://gw.example.com' },
              },
            },
          },
        },
      },
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'my-gateway', authorizerType: 'CUSTOM_JWT' }],
    });

    const result = await getGatewayEnvVars();
    expect(result).toEqual({
      AGENTCORE_GATEWAY_MY_GATEWAY_URL: 'https://gw.example.com',
      AGENTCORE_GATEWAY_MY_GATEWAY_AUTH_TYPE: 'CUSTOM_JWT',
    });
  });

  it('defaults auth type to NONE when gateway not in mcp spec', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: { mcp: { gateways: { 'test-gw': { gatewayUrl: 'https://test.com' } } } },
        },
      },
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({ agentCoreGateways: [] });

    const result = await getGatewayEnvVars();
    expect(result.AGENTCORE_GATEWAY_TEST_GW_AUTH_TYPE).toBe('NONE');
  });

  it('skips gateways without gatewayUrl', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: { mcp: { gateways: { 'no-url': {} } } },
        },
      },
    });
    mockConfigExists.mockReturnValue(false);

    const result = await getGatewayEnvVars();
    expect(result).toEqual({});
  });
});
