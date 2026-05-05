import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive.js';
import { GatewayTargetPrimitive } from '../../../primitives/GatewayTargetPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadProjectSpec, mockWriteProjectSpec, mockConfigExists } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockConfigExists: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    configExists = mockConfigExists;
  },
  requireConfigRoot: () => '/project/agentcore',
  findConfigRoot: () => '/project/agentcore',
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  serializeResult: (r: unknown) => r,
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  APP_DIR: 'app',
  MCP_APP_SUBDIR: 'mcp',
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

  it('returns empty array when no project exists', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('No project'));

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual([]);
  });

  it('returns gateway names from project spec', async () => {
    mockReadProjectSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw-1' }, { name: 'gw-2' }],
    });

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual(['gw-1', 'gw-2']);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read error'));

    const result = await gatewayPrimitive.getExistingGateways();

    expect(result).toEqual([]);
  });
});

describe('getExistingToolNames', () => {
  const gatewayTargetPrimitive = new GatewayTargetPrimitive();

  afterEach(() => vi.clearAllMocks());

  it('returns empty array when no project exists', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('No project'));

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns tool names from gateway targets', async () => {
    mockReadProjectSpec.mockResolvedValue({
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
    mockReadProjectSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gw', targets: [] }],
    });

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('corrupt'));

    const result = await gatewayTargetPrimitive.getExistingToolNames();

    expect(result).toEqual([]);
  });
});

describe('GatewayPrimitive.add (createGateway)', () => {
  const gatewayPrimitive = new GatewayPrimitive();

  afterEach(() => vi.clearAllMocks());

  it('creates gateway when project has no gateways', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'test',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await gatewayPrimitive.add({
      name: 'new-gw',
      description: 'A gateway',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, gatewayName: 'new-gw' }));
    expect(mockWriteProjectSpec).toHaveBeenCalledWith(
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
    mockReadProjectSpec.mockResolvedValue({
      name: 'test',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [{ name: 'existing-gw', targets: [] }],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await gatewayPrimitive.add({
      name: 'new-gw',
      description: 'Another',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, gatewayName: 'new-gw' }));
    expect(mockWriteProjectSpec.mock.calls[0]![0].agentCoreGateways).toHaveLength(2);
  });

  it('returns error when gateway name already exists', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'test',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [{ name: 'dup-gw', targets: [] }],
    });

    const result = await gatewayPrimitive.add({
      name: 'dup-gw',
      description: 'Duplicate',
      authorizerType: 'NONE',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ message: expect.stringContaining('Gateway "dup-gw" already exists') }),
      })
    );
  });

  it('includes JWT authorizer config when CUSTOM_JWT', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'test',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);

    await gatewayPrimitive.add({
      name: 'jwt-gw',
      description: 'JWT gateway',
      authorizerType: 'CUSTOM_JWT',
      discoveryUrl: 'https://example.com/.well-known/openid',
      allowedAudience: 'aud1',
      allowedClients: 'client1',
    });

    expect(mockWriteProjectSpec.mock.calls[0]![0].agentCoreGateways[0].authorizerConfiguration).toEqual({
      customJwtAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid',
        allowedAudience: ['aud1'],
        allowedClients: ['client1'],
      },
    });
  });
});
