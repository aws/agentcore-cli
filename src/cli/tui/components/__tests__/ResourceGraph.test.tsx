import type { AgentCoreMcpSpec, AgentCoreProjectSpec } from '../../../../schema/index.js';
import type { ResourceStatusEntry } from '../../../commands/status/action.js';
import { ResourceGraph, getTargetDisplayText } from '../ResourceGraph.js';
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
      credentials: [{ name: 'my-cred', authorizerType: 'OAuthCredentialProvider' }],
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

  it('renders agent runtime status from resourceStatuses', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const resourceStatuses: ResourceStatusEntry[] = [
      { resourceType: 'agent', name: 'my-agent', deploymentState: 'deployed', detail: 'READY' },
    ];

    const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

    expect(lastFrame()).toContain('READY');
  });

  it('renders agent error status from resourceStatuses', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const resourceStatuses: ResourceStatusEntry[] = [
      { resourceType: 'agent', name: 'my-agent', deploymentState: 'deployed', error: 'timeout' },
    ];

    const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

    expect(lastFrame()).toContain('error');
  });

  it('renders MCP gateways with targets', () => {
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
    expect(lastFrame()).toContain('target-a');
  });

  it('renders MCP gateway with deployment badge when resourceStatuses provided', () => {
    const mcp: AgentCoreMcpSpec = {
      agentCoreGateways: [
        {
          name: 'my-gateway',
          targets: [{ name: 'target-a' }],
        },
      ],
    } as unknown as AgentCoreMcpSpec;

    const resourceStatuses: ResourceStatusEntry[] = [
      {
        resourceType: 'gateway',
        name: 'my-gateway',
        deploymentState: 'deployed',
        detail: '1 target',
        identifier: 'gw-123',
      },
    ];

    const { lastFrame } = render(<ResourceGraph project={baseProject} mcp={mcp} resourceStatuses={resourceStatuses} />);

    expect(lastFrame()).toContain('my-gateway');
    expect(lastFrame()).toContain('1 target');
    expect(lastFrame()).toContain('[Deployed]');
    expect(lastFrame()).toContain('ID: gw-123');
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

  describe('deployment state badges', () => {
    it('renders Deployed badge for deployed agents', () => {
      const project = {
        ...baseProject,
        agents: [{ name: 'my-agent' }],
      } as unknown as AgentCoreProjectSpec;

      const resourceStatuses: ResourceStatusEntry[] = [
        {
          resourceType: 'agent',
          name: 'my-agent',
          deploymentState: 'deployed',
          identifier: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123',
        },
      ];

      const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('[Deployed]');
      expect(lastFrame()).toContain('ID: arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123');
    });

    it('renders Local only badge for local-only resources', () => {
      const project = {
        ...baseProject,
        agents: [{ name: 'my-agent' }],
      } as unknown as AgentCoreProjectSpec;

      const resourceStatuses: ResourceStatusEntry[] = [
        { resourceType: 'agent', name: 'my-agent', deploymentState: 'local-only' },
      ];

      const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('[Local only]');
    });

    it('renders Removed Locally section for resources removed from config', () => {
      const resourceStatuses: ResourceStatusEntry[] = [
        {
          resourceType: 'agent',
          name: 'removed-agent',
          deploymentState: 'pending-removal',
          identifier: 'arn:aws:removed',
        },
      ];

      const { lastFrame } = render(<ResourceGraph project={baseProject} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('Removed Locally');
      expect(lastFrame()).toContain('removed-agent');
      expect(lastFrame()).toContain('deploy');
    });

    it('renders deployment state legend when resourceStatuses provided', () => {
      const project = {
        ...baseProject,
        agents: [{ name: 'my-agent' }],
      } as unknown as AgentCoreProjectSpec;

      const resourceStatuses: ResourceStatusEntry[] = [
        { resourceType: 'agent', name: 'my-agent', deploymentState: 'deployed' },
      ];

      const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('[Deployed]');
      expect(lastFrame()).toContain('live in AWS');
      expect(lastFrame()).toContain('[Local only]');
      expect(lastFrame()).toContain('not yet deployed');
    });

    it('does not render deployment state legend when no resourceStatuses', () => {
      const project = {
        ...baseProject,
        agents: [{ name: 'my-agent' }],
      } as unknown as AgentCoreProjectSpec;

      const { lastFrame } = render(<ResourceGraph project={project} />);

      // Should have the base legend but not the deployment state legend
      expect(lastFrame()).toContain('agent');
      expect(lastFrame()).not.toContain('[Deployed]');
    });

    it('renders removed credentials in Removed Locally section', () => {
      const resourceStatuses: ResourceStatusEntry[] = [
        {
          resourceType: 'credential',
          name: 'old-cred',
          deploymentState: 'pending-removal',
          identifier: 'arn:aws:cred',
        },
      ];

      const { lastFrame } = render(<ResourceGraph project={baseProject} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('Removed Locally');
      expect(lastFrame()).toContain('old-cred');
    });

    it('renders deployment badges on memory resources', () => {
      const project = {
        ...baseProject,
        memories: [{ name: 'my-memory', strategies: [{ type: 'SEMANTIC' }] }],
      } as unknown as AgentCoreProjectSpec;

      const resourceStatuses: ResourceStatusEntry[] = [
        { resourceType: 'memory', name: 'my-memory', deploymentState: 'deployed' },
      ];

      const { lastFrame } = render(<ResourceGraph project={project} resourceStatuses={resourceStatuses} />);

      expect(lastFrame()).toContain('my-memory');
      expect(lastFrame()).toContain('[Deployed]');
    });
  });
});

describe('getTargetDisplayText', () => {
  it('returns endpoint for mcpServer with endpoint', () => {
    const target = { name: 'my-tool', targetType: 'mcpServer', endpoint: 'https://example.com/mcp' } as any;
    expect(getTargetDisplayText(target)).toBe('https://example.com/mcp');
  });

  it('returns restApiId/stage for apiGateway', () => {
    const target = {
      name: 'my-api',
      targetType: 'apiGateway',
      apiGateway: { restApiId: 'abc123', stage: 'prod' },
    } as any;
    expect(getTargetDisplayText(target)).toBe('abc123/prod');
  });

  it('returns name for mcpServer without endpoint', () => {
    const target = { name: 'my-tool', targetType: 'mcpServer' } as any;
    expect(getTargetDisplayText(target)).toBe('my-tool');
  });

  it('returns name for unknown target type', () => {
    const target = { name: 'my-tool', targetType: 'lambda' } as any;
    expect(getTargetDisplayText(target)).toBe('my-tool');
  });

  it('returns name for apiGateway without apiGateway config', () => {
    const target = { name: 'my-api', targetType: 'apiGateway' } as any;
    expect(getTargetDisplayText(target)).toBe('my-api');
  });

  it('returns Lambda ARN for lambdaFunctionArn target', () => {
    const target = {
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789:function:my-fn',
        toolSchemaFile: './tools.json',
      },
    } as any;
    expect(getTargetDisplayText(target)).toBe('arn:aws:lambda:us-east-1:123456789:function:my-fn');
  });

  it('returns name as fallback for lambdaFunctionArn without config', () => {
    const target = { name: 'my-lambda', targetType: 'lambdaFunctionArn' } as any;
    expect(getTargetDisplayText(target)).toBe('my-lambda');
  });
});
