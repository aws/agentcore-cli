import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive.js';
import { GatewayTargetPrimitive } from '../../../primitives/GatewayTargetPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadMcpSpec, mockWriteMcpSpec, mockReadProjectSpec, mockConfigExists } = vi.hoisted(() => ({
  mockReadMcpSpec: vi.fn(),
  mockWriteMcpSpec: vi.fn(),
  mockReadProjectSpec: vi.fn(),
  mockConfigExists: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
    readProjectSpec = mockReadProjectSpec;
    configExists = mockConfigExists;
  },
  requireConfigRoot: () => '/project/agentcore',
}));

const computeDefaultGatewayEnvVarName = (name: string) => GatewayPrimitive.computeDefaultGatewayEnvVarName(name);

describe('computeDefaultGatewayEnvVarName', () => {
  it('uppercases and wraps gateway name', () => {
    expect(computeDefaultGatewayEnvVarName('my-gateway')).toBe('AGENTCORE_GATEWAY_MY_GATEWAY_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultGatewayEnvVarName('multi-part-name')).toBe('AGENTCORE_GATEWAY_MULTI_PART_NAME_URL');
  });

  it('handles name with no hyphens', () => {
    expect(computeDefaultGatewayEnvVarName('simple')).toBe('AGENTCORE_GATEWAY_SIMPLE_URL');
  });
});

describe('getExistingGateways', () => {
  const gatewayPrimitive = new GatewayPrimitive();

  afterEach(() => vi.clearAllMocks());

  it('returns empty array when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual([]);
  });

  it('returns gateway names from mcp spec', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw-1' }, { name: 'gw-2' }],
    });

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual(['gw-1', 'gw-2']);
  });

  it('returns empty array on error', async () => {
    mockConfigExists.mockImplementation(() => {
      throw new Error('read error');
    });

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual([]);
  });
});

describe('getExistingToolNames', () => {
  const gatewayTargetPrimitive = new GatewayTargetPrimitive();

  afterEach(() => vi.clearAllMocks());

  it('returns empty array when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns tool names from gateway targets', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gw-1',
          targets: [
            {
              name: 'target-1',
              toolDefinitions: [{ name: 'gw-tool-1' }, { name: 'gw-tool-2' }],
            },
          ],
        },
      ],
    });

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual(['gw-tool-1', 'gw-tool-2']);
  });

  it('returns empty array when no gateway targets have tool definitions', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw', targets: [] }],
    });

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns empty array on error', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockRejectedValue(new Error('corrupt'));

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });
});

describe('GatewayPrimitive.add (createGateway)', () => {
  const gatewayPrimitive = new GatewayPrimitive();

  afterEach(() => vi.clearAllMocks());

  it('creates gateway when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);
    mockWriteMcpSpec.mockResolvedValue(undefined);

    const result = await gatewayPrimitive.add({
      name: 'new-gw',
      description: 'A gateway',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, gatewayName: 'new-gw' }));
    expect(mockWriteMcpSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCoreGateways: [
          expect.objectContaining({
            name: 'new-gw',
            description: 'A gateway',
            authorizerType: 'NONE',
          }),
        ],
      })
    );
  });

  it('appends to existing gateways', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'existing-gw', targets: [] }],
    });
    mockWriteMcpSpec.mockResolvedValue(undefined);

    const result = await gatewayPrimitive.add({
      name: 'new-gw',
      description: 'Another',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, gatewayName: 'new-gw' }));
    expect(mockWriteMcpSpec.mock.calls[0]![0].agentCoreGateways).toHaveLength(2);
  });

  it('returns error when gateway name already exists', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'dup-gw', targets: [] }],
    });

    const result = await gatewayPrimitive.add({
      name: 'dup-gw',
      description: 'Duplicate',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('Gateway "dup-gw" already exists') })
    );
  });

  it('includes JWT authorizer config when CUSTOM_JWT', async () => {
    mockConfigExists.mockReturnValue(false);
    mockWriteMcpSpec.mockResolvedValue(undefined);

    await gatewayPrimitive.add({
      name: 'jwt-gw',
      description: 'JWT gateway',
      authorizerType: 'CUSTOM_JWT',
      discoveryUrl: 'https://example.com/.well-known/openid',
      allowedAudience: 'aud1',
      allowedClients: 'client1',
    });

    expect(mockWriteMcpSpec.mock.calls[0]![0].agentCoreGateways[0].authorizerConfiguration).toEqual({
      customJwtAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid',
        allowedAudience: ['aud1'],
        allowedClients: ['client1'],
      },
    });
  });
});
