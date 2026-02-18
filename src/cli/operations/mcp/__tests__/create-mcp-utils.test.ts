import {
  computeDefaultGatewayEnvVarName,
  computeDefaultMcpRuntimeEnvVarName,
  createGatewayFromWizard,
  getAvailableAgents,
  getExistingGateways,
  getExistingToolNames,
} from '../create-mcp.js';
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

describe('computeDefaultMcpRuntimeEnvVarName', () => {
  it('uppercases and wraps runtime name', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('my-runtime')).toBe('AGENTCORE_MCPRUNTIME_MY_RUNTIME_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('a-b-c')).toBe('AGENTCORE_MCPRUNTIME_A_B_C_URL');
  });

  it('handles name with no hyphens', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('runtime')).toBe('AGENTCORE_MCPRUNTIME_RUNTIME_URL');
  });
});

describe('getExistingGateways', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns empty array when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);

    const result = await getExistingGateways();

    expect(result).toEqual([]);
  });

  it('returns gateway names from mcp spec', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw-1' }, { name: 'gw-2' }],
    });

    const result = await getExistingGateways();

    expect(result).toEqual(['gw-1', 'gw-2']);
  });

  it('returns empty array on error', async () => {
    mockConfigExists.mockImplementation(() => {
      throw new Error('read error');
    });

    const result = await getExistingGateways();

    expect(result).toEqual([]);
  });
});

describe('getAvailableAgents', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns agent names from project spec', async () => {
    mockReadProjectSpec.mockResolvedValue({
      agents: [{ name: 'agent-a' }, { name: 'agent-b' }],
    });

    const result = await getAvailableAgents();

    expect(result).toEqual(['agent-a', 'agent-b']);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('no project'));

    const result = await getAvailableAgents();

    expect(result).toEqual([]);
  });
});

describe('getExistingToolNames', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns empty array when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);

    const result = await getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns tool names from runtime tools and gateway targets', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      mcpRuntimeTools: [{ name: 'rt-tool-1' }],
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

    const result = await getExistingToolNames();

    expect(result).toEqual(['rt-tool-1', 'gw-tool-1', 'gw-tool-2']);
  });

  it('returns empty array when no runtime tools defined', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw', targets: [] }],
    });

    const result = await getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns empty array on error', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockRejectedValue(new Error('corrupt'));

    const result = await getExistingToolNames();

    expect(result).toEqual([]);
  });
});

describe('createGatewayFromWizard', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates gateway when mcp config does not exist', async () => {
    mockConfigExists.mockReturnValue(false);
    mockWriteMcpSpec.mockResolvedValue(undefined);

    const result = await createGatewayFromWizard({
      name: 'new-gw',
      description: 'A gateway',
      authorizerType: 'NONE',
    } as Parameters<typeof createGatewayFromWizard>[0]);

    expect(result.name).toBe('new-gw');
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

    const result = await createGatewayFromWizard({
      name: 'new-gw',
      description: 'Another',
      authorizerType: 'NONE',
    } as Parameters<typeof createGatewayFromWizard>[0]);

    expect(result.name).toBe('new-gw');
    expect(mockWriteMcpSpec.mock.calls[0]![0].agentCoreGateways).toHaveLength(2);
  });

  it('throws when gateway name already exists', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'dup-gw', targets: [] }],
    });

    await expect(
      createGatewayFromWizard({
        name: 'dup-gw',
        description: 'Duplicate',
        authorizerType: 'NONE',
      } as Parameters<typeof createGatewayFromWizard>[0])
    ).rejects.toThrow('Gateway "dup-gw" already exists');
  });

  it('includes JWT authorizer config when CUSTOM_JWT', async () => {
    mockConfigExists.mockReturnValue(false);
    mockWriteMcpSpec.mockResolvedValue(undefined);

    await createGatewayFromWizard({
      name: 'jwt-gw',
      description: 'JWT gateway',
      authorizerType: 'CUSTOM_JWT',
      jwtConfig: {
        discoveryUrl: 'https://example.com/.well-known/openid',
        allowedAudience: ['aud1'],
        allowedClients: ['client1'],
      },
    } as Parameters<typeof createGatewayFromWizard>[0]);

    expect(mockWriteMcpSpec.mock.calls[0]![0].agentCoreGateways[0].authorizerConfiguration).toEqual({
      customJwtAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid',
        allowedAudience: ['aud1'],
        allowedClients: ['client1'],
      },
    });
  });
});
