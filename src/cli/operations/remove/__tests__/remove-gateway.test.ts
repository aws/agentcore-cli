import { previewRemoveGateway, removeGateway } from '../remove-gateway.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadMcpSpec, mockWriteMcpSpec, mockConfigExists } = vi.hoisted(() => ({
  mockReadMcpSpec: vi.fn(),
  mockWriteMcpSpec: vi.fn(),
  mockConfigExists: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    configExists = mockConfigExists;
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
  },
}));

describe('removeGateway', () => {
  afterEach(() => vi.clearAllMocks());

  it('moves gateway targets to unassignedTargets on removal, preserving existing', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        { name: 'gw-to-remove', targets: [{ name: 'target-1' }, { name: 'target-2' }] },
        { name: 'other-gw', targets: [] },
      ],
      unassignedTargets: [{ name: 'already-unassigned' }],
    });

    const result = await removeGateway('gw-to-remove');

    expect(result.ok).toBe(true);
    const written = mockWriteMcpSpec.mock.calls[0]![0];
    expect(written.agentCoreGateways).toHaveLength(1);
    expect(written.agentCoreGateways[0]!.name).toBe('other-gw');
    expect(written.unassignedTargets).toHaveLength(3);
    expect(written.unassignedTargets[0]!.name).toBe('already-unassigned');
    expect(written.unassignedTargets[1]!.name).toBe('target-1');
    expect(written.unassignedTargets[2]!.name).toBe('target-2');
  });

  it('does not modify unassignedTargets when gateway has no targets', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'empty-gw', targets: [] }],
    });

    const result = await removeGateway('empty-gw');

    expect(result.ok).toBe(true);
    const written = mockWriteMcpSpec.mock.calls[0]![0];
    expect(written.agentCoreGateways).toHaveLength(0);
    expect(written.unassignedTargets).toBeUndefined();
  });
});

describe('previewRemoveGateway', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows "will become unassigned" warning when gateway has targets', async () => {
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [{ name: 'my-gw', targets: [{ name: 't1' }, { name: 't2' }] }],
    });

    const preview = await previewRemoveGateway('my-gw');

    expect(preview.summary.some(s => s.includes('2 target(s) will become unassigned'))).toBe(true);
  });
});
