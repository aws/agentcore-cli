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

  it('offsets A2A by runtime index and keeps MCP fixed', () => {
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'A2A',
        agentName: 'A',
        agentIndex: 3,
      })
    ).toBe(9003);
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

  it('uses the original project index for an A2A runtime after unsupported runtimes are filtered out', () => {
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol: 'A2A',
        agentName: 'supported-a2a',
        agentIndex: 1,
      })
    ).toBe(9001);
  });

  it.each(['HTTP', 'A2A'])('honors an explicit -p literally for a selected %s runtime', protocol => {
    expect(
      resolveAgentTargetPort({
        ...base,
        protocol,
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
