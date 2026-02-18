import {
  useRemovableAgents,
  useRemovableGateways,
  useRemovableIdentities,
  useRemovableMemories,
  useRemoveAgent,
} from '../useRemove.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the operations/remove module
const mockGetRemovableAgents = vi.fn();
const mockGetRemovableGateways = vi.fn();
const mockGetRemovableMemories = vi.fn();
const mockGetRemovableIdentities = vi.fn();
const mockRemoveAgent = vi.fn();

vi.mock('../../../operations/remove', () => ({
  getRemovableAgents: (...args: unknown[]) => mockGetRemovableAgents(...args),
  getRemovableGateways: (...args: unknown[]) => mockGetRemovableGateways(...args),
  getRemovableMcpTools: vi.fn().mockResolvedValue([]),
  getRemovableMemories: (...args: unknown[]) => mockGetRemovableMemories(...args),
  getRemovableIdentities: (...args: unknown[]) => mockGetRemovableIdentities(...args),
  previewRemoveAgent: vi.fn(),
  previewRemoveGateway: vi.fn(),
  previewRemoveMcpTool: vi.fn(),
  previewRemoveMemory: vi.fn(),
  previewRemoveIdentity: vi.fn(),
  removeAgent: (...args: unknown[]) => mockRemoveAgent(...args),
  removeGateway: vi.fn(),
  removeMcpTool: vi.fn(),
  removeMemory: vi.fn(),
  removeIdentity: vi.fn(),
}));

// Mock the logging module
vi.mock('../../../logging', () => ({
  RemoveLogger: vi.fn().mockImplementation(() => ({
    logRemoval: vi.fn(),
    getAbsoluteLogPath: vi.fn().mockReturnValue('/tmp/test.log'),
  })),
}));

function delay(ms = 100) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => vi.clearAllMocks());

// ─── Harnesses ───────────────────────────────────────────────────────

function RemovableAgentsHarness() {
  const { agents, isLoading } = useRemovableAgents();
  return (
    <Text>
      loading:{String(isLoading)} agents:{agents.join(',')}
    </Text>
  );
}

function RemovableGatewaysHarness() {
  const { gateways, isLoading } = useRemovableGateways();
  return (
    <Text>
      loading:{String(isLoading)} gateways:{gateways.join(',')}
    </Text>
  );
}

function RemovableMemoriesHarness() {
  const { memories, isLoading } = useRemovableMemories();
  return (
    <Text>
      loading:{String(isLoading)} count:{memories.length}
    </Text>
  );
}

function RemovableIdentitiesHarness() {
  const { identities, isLoading } = useRemovableIdentities();
  return (
    <Text>
      loading:{String(isLoading)} count:{identities.length}
    </Text>
  );
}

function RemoveAgentHarness({ agentName }: { agentName?: string }) {
  const { isLoading, result, remove } = useRemoveAgent();

  useEffect(() => {
    if (agentName) {
      void remove(agentName);
    }
  }, [agentName, remove]);

  return (
    <Text>
      loading:{String(isLoading)} result:{result ? (result.ok ? 'ok' : 'fail') : 'null'}
    </Text>
  );
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('useRemovableAgents', () => {
  it('starts in loading state with empty agents array', () => {
    mockGetRemovableAgents.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    );
    const { lastFrame } = render(<RemovableAgentsHarness />);

    expect(lastFrame()).toContain('loading:true');
    expect(lastFrame()).toContain('agents:');
  });

  it('loads agents and exits loading state', async () => {
    mockGetRemovableAgents.mockResolvedValue(['agent-a', 'agent-b']);
    const { lastFrame } = render(<RemovableAgentsHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('agents:agent-a,agent-b');
  });

  it('returns empty array when backend returns empty', async () => {
    mockGetRemovableAgents.mockResolvedValue([]);
    const { lastFrame } = render(<RemovableAgentsHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('agents:');
  });
});

describe('useRemovableGateways', () => {
  it('loads gateways', async () => {
    mockGetRemovableGateways.mockResolvedValue(['gw-1']);
    const { lastFrame } = render(<RemovableGatewaysHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('gateways:gw-1');
  });
});

describe('useRemovableMemories', () => {
  it('loads memories', async () => {
    mockGetRemovableMemories.mockResolvedValue([
      { name: 'mem-1', type: 'knowledge_base' },
      { name: 'mem-2', type: 'knowledge_base' },
    ]);
    const { lastFrame } = render(<RemovableMemoriesHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('count:2');
  });
});

describe('useRemovableIdentities', () => {
  it('loads identities', async () => {
    mockGetRemovableIdentities.mockResolvedValue([{ name: 'id-1', type: 'api_key' }]);
    const { lastFrame } = render(<RemovableIdentitiesHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('count:1');
  });
});

describe('useRemoveAgent', () => {
  it('starts with no result and not loading', () => {
    const { lastFrame } = render(<RemoveAgentHarness />);

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('result:null');
  });

  it('calls removeAgent and shows success result', async () => {
    mockRemoveAgent.mockResolvedValue({ ok: true });
    const { lastFrame } = render(<RemoveAgentHarness agentName="my-agent" />);

    await delay();

    expect(mockRemoveAgent).toHaveBeenCalledWith('my-agent');
    expect(lastFrame()).toContain('result:ok');
  });

  it('calls removeAgent and shows failure result', async () => {
    mockRemoveAgent.mockResolvedValue({ ok: false, error: 'Not found' });
    const { lastFrame } = render(<RemoveAgentHarness agentName="bad-agent" />);

    await delay();

    expect(mockRemoveAgent).toHaveBeenCalledWith('bad-agent');
    expect(lastFrame()).toContain('result:fail');
  });
});
