import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadMcpSpec = vi.fn();
const mockWriteMcpSpec = vi.fn();
const mockConfigExists = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
    configExists = mockConfigExists;
  },
}));

const makeMcpSpec = (gatewayNames: string[], targetsPerGateway = 0) => ({
  agentCoreGateways: gatewayNames.map(name => ({
    name,
    targets: Array.from({ length: targetsPerGateway }, (_, i) => ({
      name: `target-${i}`,
      targetType: 'mcpServer',
      toolDefinitions: [],
    })),
  })),
});

const primitive = new GatewayPrimitive();

describe('getRemovable', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns gateway resources', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec(['gw1', 'gw2']));

    const result = await primitive.getRemovable();

    expect(result).toEqual([{ name: 'gw1' }, { name: 'gw2' }]);
  });

  it('returns empty when no mcp config', async () => {
    mockConfigExists.mockReturnValue(false);

    expect(await primitive.getRemovable()).toEqual([]);
  });

  it('returns empty on error', async () => {
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockRejectedValue(new Error('fail'));

    expect(await primitive.getRemovable()).toEqual([]);
  });
});

describe('previewRemove', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview for gateway without targets', async () => {
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec(['myGw']));

    const preview = await primitive.previewRemove('myGw');

    expect(preview.summary).toContain('Removing gateway: myGw');
    expect(preview.schemaChanges).toHaveLength(1);
  });

  it('notes orphaned targets when gateway has targets', async () => {
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec(['myGw'], 3));

    const preview = await primitive.previewRemove('myGw');

    expect(preview.summary.some((s: string) => s.includes('3 target(s)'))).toBe(true);
  });

  it('throws when gateway not found', async () => {
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec(['other']));

    await expect(primitive.previewRemove('missing')).rejects.toThrow('Gateway "missing" not found');
  });
});

describe('remove', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes gateway and writes spec', async () => {
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec(['gw1', 'gw2']));
    mockWriteMcpSpec.mockResolvedValue(undefined);

    const result = await primitive.remove('gw1');

    expect(result).toEqual({ success: true });
    expect(mockWriteMcpSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCoreGateways: [expect.objectContaining({ name: 'gw2' })],
      })
    );
  });

  it('returns error when gateway not found', async () => {
    mockReadMcpSpec.mockResolvedValue(makeMcpSpec([]));

    const result = await primitive.remove('missing');

    expect(result).toEqual({ success: false, error: 'Gateway "missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadMcpSpec.mockRejectedValue(new Error('read fail'));

    const result = await primitive.remove('gw1');

    expect(result).toEqual({ success: false, error: 'read fail' });
  });
});
