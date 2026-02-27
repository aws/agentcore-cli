import type { AddGatewayConfig, AddGatewayTargetConfig } from '../../../tui/screens/mcp/types.js';
import { createExternalGatewayTarget, createGatewayFromWizard, getUnassignedTargets } from '../create-mcp.js';
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

  it('throws when gateway is not provided', async () => {
    const mockMcpSpec = { agentCoreGateways: [{ name: 'test-gateway', targets: [] }] };
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);

    await expect(createExternalGatewayTarget(makeExternalConfig({ gateway: undefined }))).rejects.toThrow(
      'Gateway is required'
    );
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

describe('getUnassignedTargets', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns unassigned targets from mcp spec', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [],
      unassignedTargets: [{ name: 't1' }, { name: 't2' }],
    });

    const result = await getUnassignedTargets();
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('t1');
  });

  it('returns empty array when no mcp config exists', async () => {
    mockConfigExists.mockReturnValue(false);
    expect(await getUnassignedTargets()).toEqual([]);
  });

  it('returns empty array when unassignedTargets field is missing', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({ agentCoreGateways: [] });
    expect(await getUnassignedTargets()).toEqual([]);
  });
});

describe('createGatewayFromWizard with selectedTargets', () => {
  afterEach(() => vi.clearAllMocks());

  function makeGatewayConfig(overrides: Partial<AddGatewayConfig> = {}): AddGatewayConfig {
    return {
      name: 'new-gateway',
      authorizerType: 'AWS_IAM',
      ...overrides,
    } as AddGatewayConfig;
  }

  it('moves selected targets to new gateway and removes from unassigned', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [],
      unassignedTargets: [
        { name: 'target-a', targetType: 'mcpServer' },
        { name: 'target-b', targetType: 'mcpServer' },
        { name: 'target-c', targetType: 'mcpServer' },
      ],
    });

    await createGatewayFromWizard(makeGatewayConfig({ selectedTargets: ['target-a', 'target-c'] }));

    const written = mockWriteMcpSpec.mock.calls[0]![0];
    const gateway = written.agentCoreGateways.find((g: { name: string }) => g.name === 'new-gateway');
    expect(gateway.targets).toHaveLength(2);
    expect(gateway.targets[0]!.name).toBe('target-a');
    expect(gateway.targets[1]!.name).toBe('target-c');
    expect(written.unassignedTargets).toHaveLength(1);
    expect(written.unassignedTargets[0]!.name).toBe('target-b');
  });

  it('creates gateway with empty targets when no selectedTargets', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({ agentCoreGateways: [] });

    await createGatewayFromWizard(makeGatewayConfig());

    const written = mockWriteMcpSpec.mock.calls[0]![0];
    const gateway = written.agentCoreGateways.find((g: { name: string }) => g.name === 'new-gateway');
    expect(gateway.targets).toHaveLength(0);
  });
});
