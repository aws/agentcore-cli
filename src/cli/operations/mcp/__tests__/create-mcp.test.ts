import { SKIP_FOR_NOW } from '../../../tui/screens/mcp/types.js';
import type { AddGatewayTargetConfig } from '../../../tui/screens/mcp/types.js';
import { createExternalGatewayTarget } from '../create-mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadMcpSpec, mockWriteMcpSpec, mockConfigExists, mockReadProjectSpec } = vi.hoisted(() => ({
  mockReadMcpSpec: vi.fn(),
  mockWriteMcpSpec: vi.fn(),
  mockConfigExists: vi.fn(),
  mockReadProjectSpec: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    configExists = mockConfigExists;
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
    readProjectSpec = mockReadProjectSpec;
  },
}));

function makeExternalConfig(overrides: Partial<AddGatewayTargetConfig> = {}): AddGatewayTargetConfig {
  return {
    name: 'test-target',
    description: 'Test target',
    sourcePath: '/tmp/test',
    language: 'Other',
    source: 'existing-endpoint',
    endpoint: 'https://api.example.com',
    gateway: 'test-gateway',
    host: 'Lambda',
    toolDefinition: { name: 'test-tool', description: 'Test tool' },
    ...overrides,
  } as AddGatewayTargetConfig;
}

describe('createExternalGatewayTarget', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates target with endpoint and assigns to specified gateway', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [{ name: 'test-gateway', targets: [] }],
    };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await createExternalGatewayTarget(makeExternalConfig());

    expect(mockWriteMcpSpec).toHaveBeenCalled();
    const written = mockWriteMcpSpec.mock.calls[0]![0];
    const gateway = written.agentCoreGateways[0]!;
    expect(gateway.targets).toHaveLength(1);
    expect(gateway.targets[0]!.name).toBe('test-target');
    expect(gateway.targets[0]!.endpoint).toBe('https://api.example.com');
    expect(gateway.targets[0]!.targetType).toBe('mcpServer');
  });

  it('stores target in unassignedTargets when gateway is skip-for-now', async () => {
    const mockMcpSpec = { agentCoreGateways: [] };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await createExternalGatewayTarget(makeExternalConfig({ gateway: SKIP_FOR_NOW }));

    expect(mockWriteMcpSpec).toHaveBeenCalled();
    const written = mockWriteMcpSpec.mock.calls[0]![0];
    expect(written.unassignedTargets).toHaveLength(1);
    expect(written.unassignedTargets[0]!.name).toBe('test-target');
    expect(written.unassignedTargets[0]!.endpoint).toBe('https://api.example.com');
  });

  it('initializes unassignedTargets array if it does not exist in mcp spec', async () => {
    const mockMcpSpec = { agentCoreGateways: [] };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await createExternalGatewayTarget(makeExternalConfig({ gateway: SKIP_FOR_NOW }));

    const written = mockWriteMcpSpec.mock.calls[0]![0];
    expect(Array.isArray(written.unassignedTargets)).toBe(true);
  });

  it('throws on duplicate target name in gateway', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [{ name: 'test-gateway', targets: [{ name: 'test-target' }] }],
    };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await expect(createExternalGatewayTarget(makeExternalConfig())).rejects.toThrow(
      'Target "test-target" already exists in gateway "test-gateway"'
    );
  });

  it('throws on duplicate target name in unassigned targets', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [],
      unassignedTargets: [{ name: 'test-target' }],
    };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await expect(createExternalGatewayTarget(makeExternalConfig({ gateway: SKIP_FOR_NOW }))).rejects.toThrow(
      'Unassigned target "test-target" already exists'
    );
  });

  it('throws when gateway not found', async () => {
    const mockMcpSpec = { agentCoreGateways: [] };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await expect(createExternalGatewayTarget(makeExternalConfig({ gateway: 'nonexistent' }))).rejects.toThrow(
      'Gateway "nonexistent" not found'
    );
  });

  it('includes outboundAuth when configured', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [{ name: 'test-gateway', targets: [] }],
    };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await createExternalGatewayTarget(
      makeExternalConfig({ outboundAuth: { type: 'API_KEY', credentialName: 'my-cred' } })
    );

    const written = mockWriteMcpSpec.mock.calls[0]![0];
    const target = written.agentCoreGateways[0]!.targets[0]!;
    expect(target.outboundAuth).toEqual({ type: 'API_KEY', credentialName: 'my-cred' });
  });
});
