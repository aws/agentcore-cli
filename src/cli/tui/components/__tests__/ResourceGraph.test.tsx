import type { AgentCoreMcpSpec, AgentCoreProjectSpec } from '../../../../schema/index.js';
import { ResourceGraph } from '../ResourceGraph.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

const baseProject: AgentCoreProjectSpec = {
  name: 'test-project',
  agents: [],
  memories: [],
  credentials: [],
} as unknown as AgentCoreProjectSpec;

describe('ResourceGraph', () => {
  it('renders project name', () => {
    const { lastFrame } = render(<ResourceGraph project={baseProject} />);

    expect(lastFrame()).toContain('test-project');
  });

  it('shows empty state when no resources configured', () => {
    const { lastFrame } = render(<ResourceGraph project={baseProject} />);

    expect(lastFrame()).toContain('No resources configured');
  });

  it('renders agents section', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(<ResourceGraph project={project} />);

    expect(lastFrame()).toContain('Agents');
    expect(lastFrame()).toContain('my-agent');
  });

  it('renders memories with strategies', () => {
    const project = {
      ...baseProject,
      memories: [{ name: 'my-memory', strategies: [{ type: 'semantic_search' }] }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(<ResourceGraph project={project} />);

    expect(lastFrame()).toContain('Memories');
    expect(lastFrame()).toContain('my-memory');
    expect(lastFrame()).toContain('semantic_search');
  });

  it('renders credentials section', () => {
    const project = {
      ...baseProject,
      credentials: [{ name: 'my-cred', type: 'OAuthCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(<ResourceGraph project={project} />);

    expect(lastFrame()).toContain('Credentials');
    expect(lastFrame()).toContain('my-cred');
    expect(lastFrame()).toContain('OAuth');
  });

  it('filters agents by agentName prop', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'agent-a' }, { name: 'agent-b' }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(<ResourceGraph project={project} agentName="agent-a" />);

    expect(lastFrame()).toContain('agent-a');
    expect(lastFrame()).not.toContain('agent-b');
  });

  it('renders agent status when provided', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(
      <ResourceGraph project={project} agentStatuses={{ 'my-agent': { runtimeStatus: 'READY' } }} />
    );

    expect(lastFrame()).toContain('READY');
  });

  it('renders agent error status', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const { lastFrame } = render(
      <ResourceGraph project={project} agentStatuses={{ 'my-agent': { error: 'timeout' } }} />
    );

    expect(lastFrame()).toContain('error');
  });

  it('renders MCP gateways with tool counts', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [
        {
          name: 'my-gateway',
          targets: [{ name: 'target-a', toolDefinitions: [{ name: 'tool-a' }, { name: 'tool-b' }] }],
        },
      ],
    } as unknown as AgentCoreMcpSpec;

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} />);

    expect(lastFrame()).toContain('Gateways');
    expect(lastFrame()).toContain('my-gateway');
    expect(lastFrame()).toContain('2 tools');
    expect(lastFrame()).toContain('target-a');
  });

  it('renders MCP runtime tools', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [],
      mcpRuntimeTools: [{ name: 'runtime-tool', toolDefinition: { name: 'rt-display' } }],
    } as unknown as AgentCoreMcpSpec;

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} />);

    expect(lastFrame()).toContain('Runtime Tools');
    expect(lastFrame()).toContain('rt-display');
  });

  it('renders legend', () => {
    const { lastFrame } = render(<ResourceGraph project={baseProject} />);

    expect(lastFrame()).toContain('agent');
    expect(lastFrame()).toContain('memory');
    expect(lastFrame()).toContain('credential');
  });

  it('renders ⚠ indicator when unassigned targets exist in mcp spec', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [],
      unassignedTargets: [{ name: 'unassigned-target', targetType: 'mcpServer' }],
    } as unknown as AgentCoreMcpSpec;

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} />);

    expect(lastFrame()).toContain('⚠ Unassigned Targets');
    expect(lastFrame()).toContain('⚠');
  });

  it('shows unassigned target names', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [],
      unassignedTargets: [
        { name: 'target-1', targetType: 'mcpServer' },
        { name: 'target-2', targetType: 'mcpServer' },
      ],
    } as unknown as AgentCoreMcpSpec;

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} />);

    expect(lastFrame()).toContain('target-1');
    expect(lastFrame()).toContain('target-2');
  });

  it('does not render unassigned section when no unassigned targets', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [],
      unassignedTargets: [],
    } as unknown as AgentCoreMcpSpec;

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} />);

    expect(lastFrame()).not.toContain('⚠ Unassigned Targets');
  });
});
