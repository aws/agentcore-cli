import {
  getRemovableGatewayTargets,
  previewRemoveGatewayTarget,
  removeGatewayTarget,
} from '../remove-gateway-target.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadMcpSpec, mockWriteMcpSpec, mockReadMcpDefs, mockWriteMcpDefs, mockConfigExists, mockGetProjectRoot } =
  vi.hoisted(() => ({
    mockReadMcpSpec: vi.fn(),
    mockWriteMcpSpec: vi.fn(),
    mockReadMcpDefs: vi.fn(),
    mockWriteMcpDefs: vi.fn(),
    mockConfigExists: vi.fn(),
    mockGetProjectRoot: vi.fn(),
  }));

const { mockExistsSync, mockRm } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    configExists = mockConfigExists;
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
    readMcpDefs = mockReadMcpDefs;
    writeMcpDefs = mockWriteMcpDefs;
    getProjectRoot = mockGetProjectRoot;
  },
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('fs/promises', () => ({
  rm: mockRm,
}));

describe('getRemovableGatewayTargets', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns targets from all gateways with gateway name attached', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gateway-1',
          targets: [{ name: 'target-1' }, { name: 'target-2' }],
        },
        {
          name: 'gateway-2',
          targets: [{ name: 'target-3' }],
        },
      ],
    });

    const result = await getRemovableGatewayTargets();

    expect(result).toEqual([
      { name: 'target-1', type: 'gateway-target', gatewayName: 'gateway-1' },
      { name: 'target-2', type: 'gateway-target', gatewayName: 'gateway-1' },
      { name: 'target-3', type: 'gateway-target', gatewayName: 'gateway-2' },
    ]);
  });

  it('returns empty array when no gateways', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [],
    });

    const result = await getRemovableGatewayTargets();

    expect(result).toEqual([]);
  });

  it('returns empty array when gateways have no targets', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'gateway-1', targets: [] }],
    });

    const result = await getRemovableGatewayTargets();

    expect(result).toEqual([]);
  });
});

describe('previewRemoveGatewayTarget', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows files that will be deleted for scaffolded targets', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [
            {
              name: 'test-target',
              compute: {
                implementation: { path: 'app/test-target' },
              },
              toolDefinitions: [{ name: 'test-tool' }],
            },
          ],
        },
      ],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpDefs.mockResolvedValue({
      tools: { 'test-tool': { name: 'test-tool' } },
    });
    mockGetProjectRoot.mockReturnValue('/project');
    mockExistsSync.mockReturnValue(true);

    const target = { name: 'test-target', type: 'gateway-target' as const, gatewayName: 'test-gateway' };
    const result = await previewRemoveGatewayTarget(target);

    expect(result.summary).toContain('Removing gateway target: test-target (from test-gateway)');
    expect(result.summary).toContain('Deleting directory: app/test-target');
    expect(result.summary).toContain('Removing tool definition: test-tool');
    expect(result.directoriesToDelete).toEqual(['/project/app/test-target']);
  });

  it('shows correct gateway name in preview', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'my-gateway',
          targets: [
            {
              name: 'my-target',
              toolDefinitions: [{ name: 'my-tool' }],
            },
          ],
        },
      ],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpDefs.mockResolvedValue({ tools: {} });
    mockGetProjectRoot.mockReturnValue('/project');

    const target = { name: 'my-target', type: 'gateway-target' as const, gatewayName: 'my-gateway' };
    const result = await previewRemoveGatewayTarget(target);

    expect(result.summary).toContain('Removing gateway target: my-target (from my-gateway)');
  });

  it('handles external targets with no files to delete', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [
            {
              name: 'external-target',
              endpoint: 'https://api.example.com',
              toolDefinitions: [{ name: 'external-tool' }],
            },
          ],
        },
      ],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpDefs.mockResolvedValue({ tools: {} });
    mockGetProjectRoot.mockReturnValue('/project');

    const target = { name: 'external-target', type: 'gateway-target' as const, gatewayName: 'test-gateway' };
    const result = await previewRemoveGatewayTarget(target);

    expect(result.summary).toContain('Removing gateway target: external-target (from test-gateway)');
    expect(result.directoriesToDelete).toEqual([]);
  });
});

describe('removeGatewayTarget', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes target from gateway config and writes updated mcp.json', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [{ name: 'target-1' }, { name: 'target-2' }],
        },
      ],
    };
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);
    mockConfigExists.mockReturnValue(true);
    mockReadMcpDefs.mockResolvedValue({ tools: {} });
    mockGetProjectRoot.mockReturnValue('/project');

    const target = { name: 'target-1', type: 'gateway-target' as const, gatewayName: 'test-gateway' };
    const result = await removeGatewayTarget(target);

    expect(result.ok).toBe(true);
    expect(mockWriteMcpSpec).toHaveBeenCalledWith({
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [{ name: 'target-2' }],
        },
      ],
    });
  });

  it('handles last target in gateway', async () => {
    const mockMcpSpec = {
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [{ name: 'last-target' }],
        },
      ],
    };
    mockReadMcpSpec.mockResolvedValue(mockMcpSpec);
    mockConfigExists.mockReturnValue(true);
    mockReadMcpDefs.mockResolvedValue({ tools: {} });
    mockGetProjectRoot.mockReturnValue('/project');

    const target = { name: 'last-target', type: 'gateway-target' as const, gatewayName: 'test-gateway' };
    const result = await removeGatewayTarget(target);

    expect(result.ok).toBe(true);
    expect(mockWriteMcpSpec).toHaveBeenCalledWith({
      agentCoreGateways: [
        {
          name: 'test-gateway',
          targets: [],
        },
      ],
    });
  });
});
