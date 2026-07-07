import { resolveAgentTargetPort } from '../handlers/start.js';
import { describe, expect, it } from 'vitest';

describe('resolveAgentTargetPort', () => {
  const base = { uiPort: 7777 };

  it('uses uiPort + 1 + index for HTTP runtimes when no explicit -p is set', () => {
    expect(resolveAgentTargetPort({ ...base, protocol: 'HTTP', agentName: 'A', agentIndex: 0 })).toBe(7778);
    expect(resolveAgentTargetPort({ ...base, protocol: 'HTTP', agentName: 'B', agentIndex: 1 })).toBe(7779);
  });

  it('falls back to index 0 when the agent is not found', () => {
    expect(resolveAgentTargetPort({ ...base, protocol: 'HTTP', agentName: 'missing', agentIndex: -1 })).toBe(7778);
  });

  it('uses framework-fixed ports for A2A and MCP regardless of -p', () => {
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'A2A',
        agentName: 'A',
        agentIndex: 3,
        agentBasePort: 8788,
        selectedAgent: 'A',
      })
    ).toBe(9000);
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'MCP',
        agentName: 'A',
        agentIndex: 3,
        agentBasePort: 8788,
        selectedAgent: 'A',
      })
    ).toBe(8000);
  });

  it('honors an explicit -p literally for the selected runtime (no offset)', () => {
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'HTTP',
        agentName: 'AgentB',
        agentIndex: 1,
        agentBasePort: 8788,
        selectedAgent: 'AgentB',
      })
    ).toBe(8788);
  });

  it('keeps the default allocation for non-selected runtimes even when -p is explicit', () => {
    // AgentA (index 0) is not selected, so it never binds below the requested -p.
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'HTTP',
        agentName: 'AgentA',
        agentIndex: 0,
        agentBasePort: 8788,
        selectedAgent: 'AgentB',
      })
    ).toBe(7778);
    // AgentC (index 2) likewise uses the default base, not a port derived from -p.
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'HTTP',
        agentName: 'AgentC',
        agentIndex: 2,
        agentBasePort: 8788,
        selectedAgent: 'AgentB',
      })
    ).toBe(7780);
  });
});
