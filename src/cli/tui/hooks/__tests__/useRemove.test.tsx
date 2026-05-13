import {
  useRemovableAgents,
  useRemovableGateways,
  useRemovableIdentities,
  useRemovableMemories,
  useRemovablePolicies,
  useRemovablePolicyEngines,
  useRemoveAgent,
} from '../useRemove.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the primitives registry module (useRemove.ts now imports from here)
const mockAgentGetRemovable = vi.fn();
const mockAgentRemove = vi.fn();
const mockAgentPreviewRemove = vi.fn();
const mockGatewayGetRemovable = vi.fn();
const mockGatewayRemove = vi.fn();
const mockGatewayPreviewRemove = vi.fn();
const mockGatewayTargetGetRemovable = vi.fn();
const mockGatewayTargetRemoveMcpTool = vi.fn();
const mockGatewayTargetPreviewRemoveMcpTool = vi.fn();
const mockMemoryGetRemovable = vi.fn();
const mockMemoryRemove = vi.fn();
const mockMemoryPreviewRemove = vi.fn();
const mockCredentialGetRemovable = vi.fn();
const mockCredentialRemove = vi.fn();
const mockCredentialPreviewRemove = vi.fn();
const mockPolicyEngineGetRemovable = vi.fn();
const mockPolicyEngineRemove = vi.fn();
const mockPolicyEnginePreviewRemove = vi.fn();
const mockPolicyGetRemovable = vi.fn();
const mockPolicyRemove = vi.fn();
const mockPolicyPreviewRemove = vi.fn();

vi.mock('../../../primitives/registry', () => ({
  agentPrimitive: {
    getRemovable: (...args: unknown[]) => mockAgentGetRemovable(...args),
    remove: (...args: unknown[]) => mockAgentRemove(...args),
    previewRemove: (...args: unknown[]) => mockAgentPreviewRemove(...args),
  },
  gatewayPrimitive: {
    getRemovable: (...args: unknown[]) => mockGatewayGetRemovable(...args),
    remove: (...args: unknown[]) => mockGatewayRemove(...args),
    previewRemove: (...args: unknown[]) => mockGatewayPreviewRemove(...args),
  },
  gatewayTargetPrimitive: {
    getRemovable: (...args: unknown[]) => mockGatewayTargetGetRemovable(...args),
    removeGatewayTarget: (...args: unknown[]) => mockGatewayTargetRemoveMcpTool(...args),
    previewRemoveGatewayTarget: (...args: unknown[]) => mockGatewayTargetPreviewRemoveMcpTool(...args),
  },
  memoryPrimitive: {
    getRemovable: (...args: unknown[]) => mockMemoryGetRemovable(...args),
    remove: (...args: unknown[]) => mockMemoryRemove(...args),
    previewRemove: (...args: unknown[]) => mockMemoryPreviewRemove(...args),
  },
  credentialPrimitive: {
    getRemovable: (...args: unknown[]) => mockCredentialGetRemovable(...args),
    remove: (...args: unknown[]) => mockCredentialRemove(...args),
    previewRemove: (...args: unknown[]) => mockCredentialPreviewRemove(...args),
  },
  policyEnginePrimitive: {
    getRemovable: (...args: unknown[]) => mockPolicyEngineGetRemovable(...args),
    remove: (...args: unknown[]) => mockPolicyEngineRemove(...args),
    previewRemove: (...args: unknown[]) => mockPolicyEnginePreviewRemove(...args),
  },
  policyPrimitive: {
    getRemovable: (...args: unknown[]) => mockPolicyGetRemovable(...args),
    remove: (...args: unknown[]) => mockPolicyRemove(...args),
    previewRemove: (...args: unknown[]) => mockPolicyPreviewRemove(...args),
  },
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
      loading:{String(isLoading)} result:{result ? (result.success ? 'ok' : 'fail') : 'null'}
    </Text>
  );
}

function RemovablePolicyEnginesHarness() {
  const { policyEngines, isLoading } = useRemovablePolicyEngines();
  return (
    <Text>
      loading:{String(isLoading)} count:{policyEngines.length}
    </Text>
  );
}

function RemovablePoliciesHarness() {
  const { policies, isLoading } = useRemovablePolicies();
  return (
    <Text>
      loading:{String(isLoading)} count:{policies.length}
    </Text>
  );
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('useRemovableAgents', () => {
  it('starts in loading state with empty agents array', () => {
    mockAgentGetRemovable.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    );
    const { lastFrame } = render(<RemovableAgentsHarness />);

    expect(lastFrame()).toContain('loading:true');
    expect(lastFrame()).toContain('agents:');
  });

  it('loads agents and exits loading state', async () => {
    // getRemovable returns RemovableResource[] (objects with name), hook maps to names
    mockAgentGetRemovable.mockResolvedValue([{ name: 'agent-a' }, { name: 'agent-b' }]);
    const { lastFrame } = render(<RemovableAgentsHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('agents:agent-a,agent-b');
  });

  it('returns empty array when backend returns empty', async () => {
    mockAgentGetRemovable.mockResolvedValue([]);
    const { lastFrame } = render(<RemovableAgentsHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('agents:');
  });
});

describe('useRemovableGateways', () => {
  it('loads gateways', async () => {
    mockGatewayGetRemovable.mockResolvedValue([{ name: 'gw-1' }]);
    const { lastFrame } = render(<RemovableGatewaysHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('gateways:gw-1');
  });
});

describe('useRemovableMemories', () => {
  it('loads memories', async () => {
    mockMemoryGetRemovable.mockResolvedValue([
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
    mockCredentialGetRemovable.mockResolvedValue([{ name: 'id-1', type: 'api_key' }]);
    const { lastFrame } = render(<RemovableIdentitiesHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('count:1');
  });
});

describe('useRemovablePolicyEngines', () => {
  it('loads policy engines', async () => {
    mockPolicyEngineGetRemovable.mockResolvedValue([{ name: 'engine-1' }, { name: 'engine-2' }]);
    const { lastFrame } = render(<RemovablePolicyEnginesHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('count:2');
  });
});

describe('useRemovablePolicies', () => {
  it('loads policies', async () => {
    mockPolicyGetRemovable.mockResolvedValue([
      { name: 'engine-1/policy-a', engineName: 'engine-1' },
      { name: 'engine-1/policy-b', engineName: 'engine-1' },
    ]);
    const { lastFrame } = render(<RemovablePoliciesHarness />);

    await delay();

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('count:2');
  });
});

describe('useRemoveAgent', () => {
  it('starts with no result and not loading', () => {
    const { lastFrame } = render(<RemoveAgentHarness />);

    expect(lastFrame()).toContain('loading:false');
    expect(lastFrame()).toContain('result:null');
  });

  it('calls removeAgent and shows success result', async () => {
    mockAgentRemove.mockResolvedValue({ success: true });
    const { lastFrame } = render(<RemoveAgentHarness agentName="my-agent" />);

    await delay();

    expect(mockAgentRemove).toHaveBeenCalledWith('my-agent');
    expect(lastFrame()).toContain('result:ok');
  });

  it('calls removeAgent and shows failure result', async () => {
    mockAgentRemove.mockResolvedValue({ success: false, error: new Error('Not found') });
    const { lastFrame } = render(<RemoveAgentHarness agentName="bad-agent" />);

    await delay();

    expect(mockAgentRemove).toHaveBeenCalledWith('bad-agent');
    expect(lastFrame()).toContain('result:fail');
  });
});
