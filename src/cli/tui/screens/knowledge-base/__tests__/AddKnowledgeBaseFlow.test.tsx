import { AddKnowledgeBaseFlow } from '../AddKnowledgeBaseFlow';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── mocks ───────────────────────────────────────────────────────────────────
const mockKbAdd = vi.fn();
const mockKbGetRemovable = vi.fn();
const mockGatewayAdd = vi.fn();

vi.mock('../../../../primitives/registry', () => ({
  knowledgeBasePrimitive: {
    add: (...args: unknown[]) => mockKbAdd(...args),
    getRemovable: (...args: unknown[]) => mockKbGetRemovable(...args),
  },
  gatewayPrimitive: {
    add: (...args: unknown[]) => mockGatewayAdd(...args),
  },
}));

vi.mock('../../../hooks/useCreateMcp', () => ({
  useExistingGateways: () => ({ gateways: [] }),
}));

// Replace the screen with a stub that immediately invokes onComplete with a
// fixed config — keeps Flow tests focused on the post-screen logic.
vi.mock('../AddKnowledgeBaseScreen', () => {
  return {
    AddKnowledgeBaseScreen: ({ onComplete }: { onComplete: (cfg: unknown) => void }) => {
      // Immediately submit on first render. Tests below customise the payload
      // by setting a global before the render.
      const cfg = (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG;
      React.useEffect(() => {
        if (cfg) onComplete(cfg);
      }, [onComplete, cfg]);
      return null;
    },
  };
});

// ─── helpers ─────────────────────────────────────────────────────────────────
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  mockKbAdd.mockReset();
  mockKbGetRemovable.mockReset();
  mockGatewayAdd.mockReset();
  mockKbGetRemovable.mockResolvedValue([]);
  mockKbAdd.mockResolvedValue({
    success: true,
    knowledgeBaseName: 'kb1',
    newDataSources: ['s3-1'],
    gatewayWired: undefined,
  });
  mockGatewayAdd.mockResolvedValue({ success: true, gatewayName: 'tui-kb-gw' });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG;
});

// ─── tests ───────────────────────────────────────────────────────────────────
describe('AddKnowledgeBaseFlow — newGatewayName path', () => {
  it('creates the gateway first, then adds the KB with that gateway name', async () => {
    (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG = {
      name: 'tui-kb',
      dataSources: [{ dataSourceType: 's3', value: 's3://b/' }],
      newGatewayName: 'tui-kb-gw',
    };
    mockKbAdd.mockResolvedValueOnce({ success: true, newDataSources: ['s3-1'], gatewayWired: 'tui-kb-gw' });

    render(<AddKnowledgeBaseFlow onExit={vi.fn()} onBack={vi.fn()} />);
    await delay(80);

    expect(mockGatewayAdd).toHaveBeenCalledTimes(1);
    expect(mockGatewayAdd.mock.calls[0]![0]).toMatchObject({ name: 'tui-kb-gw', authorizerType: 'NONE' });
    expect(mockKbAdd).toHaveBeenCalledTimes(1);
    expect(mockKbAdd.mock.calls[0]![0]).toMatchObject({ name: 'tui-kb', gateway: 'tui-kb-gw' });
  });

  it('aborts (no KB add) if the gateway create fails', async () => {
    (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG = {
      name: 'tui-kb',
      dataSources: [{ dataSourceType: 's3', value: 's3://b/' }],
      newGatewayName: 'tui-kb-gw',
    };
    mockGatewayAdd.mockResolvedValueOnce({ success: false, error: new Error('boom') });

    const { lastFrame } = render(<AddKnowledgeBaseFlow onExit={vi.fn()} onBack={vi.fn()} />);
    await delay(80);

    expect(mockGatewayAdd).toHaveBeenCalledTimes(1);
    expect(mockKbAdd).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Failed');
  });
});

describe('AddKnowledgeBaseFlow — Skip / standalone path (zero gateways case)', () => {
  it('does not call gatewayPrimitive.add and adds the KB with no gateway', async () => {
    (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG = {
      name: 'standalone-kb',
      dataSources: [{ dataSourceType: 's3', value: 's3://b/' }],
      // No gateway, no newGatewayName
    };
    mockKbAdd.mockResolvedValueOnce({ success: true, newDataSources: ['s3-1'], gatewayWired: undefined });

    render(<AddKnowledgeBaseFlow onExit={vi.fn()} onBack={vi.fn()} />);
    await delay(80);

    expect(mockGatewayAdd).not.toHaveBeenCalled();
    expect(mockKbAdd).toHaveBeenCalledTimes(1);
    expect(mockKbAdd.mock.calls[0]![0]).toMatchObject({ name: 'standalone-kb' });
    expect(mockKbAdd.mock.calls[0]![0].gateway).toBeUndefined();
  });
});

describe('AddKnowledgeBaseFlow — existing gateway path', () => {
  it('passes the existing gateway through to KB add and skips gateway create', async () => {
    (globalThis as { __KB_FLOW_TEST_CFG?: unknown }).__KB_FLOW_TEST_CFG = {
      name: 'kb-existing',
      dataSources: [{ dataSourceType: 's3', value: 's3://b/' }],
      gateway: 'g1',
    };
    mockKbAdd.mockResolvedValueOnce({ success: true, newDataSources: ['s3-1'], gatewayWired: 'g1' });

    render(<AddKnowledgeBaseFlow onExit={vi.fn()} onBack={vi.fn()} />);
    await delay(80);

    expect(mockGatewayAdd).not.toHaveBeenCalled();
    expect(mockKbAdd).toHaveBeenCalledTimes(1);
    expect(mockKbAdd.mock.calls[0]![0]).toMatchObject({ name: 'kb-existing', gateway: 'g1' });
  });
});
