import type {
  AgentCoreDeployedState,
  AgentCoreGateway,
  AgentCoreMcpRuntimeTool,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
} from '../../../schema';
import { Box, Text } from 'ink';
import React from 'react';

const ICONS = {
  agent: '●',
  memory: '■',
  credential: '◇',
  gateway: '◆',
  tool: '⚙',
  runtime: '▶',
} as const;

export interface AgentStatusInfo {
  runtimeStatus?: string;
  error?: string;
}

interface ResourceGraphProps {
  project: AgentCoreProjectSpec;
  mcp?: AgentCoreMcpSpec;
  agentName?: string;
  agentStatuses?: Record<string, AgentStatusInfo>;
  deployedAgents?: Record<string, AgentCoreDeployedState>;
}

function getStatusColor(status?: string): string {
  if (!status) return 'gray';
  switch (status.toUpperCase()) {
    case 'READY':
      return 'green';
    case 'ACTIVE':
      return 'cyan';
    case 'CREATING':
    case 'UPDATING':
      return 'yellow';
    case 'FAILED':
      return 'red';
    default:
      return 'yellow';
  }
}

function SectionHeader({ children }: { children: string }) {
  return (
    <Box marginTop={1}>
      <Text color="white">{children}</Text>
    </Box>
  );
}

function ResourceRow({
  icon,
  color,
  name,
  detail,
  status,
  statusColor,
}: {
  icon: string;
  color: string;
  name: string;
  detail?: string;
  status?: string;
  statusColor?: string;
}) {
  return (
    <Text>
      {'  '}
      <Text color={color}>{icon}</Text> {name}
      {detail && <Text color="gray"> {detail}</Text>}
      {status && <Text color={statusColor ?? 'gray'}> [{status}]</Text>}
    </Text>
  );
}

export function ResourceGraph({ project, mcp, agentName, agentStatuses, deployedAgents }: ResourceGraphProps) {
  const allAgents = project.agents ?? [];
  const agents = agentName ? allAgents.filter(a => a.name === agentName) : allAgents;
  const memories = project.memories ?? [];
  const credentials = project.credentials ?? [];
  const gateways = mcp?.agentCoreGateways ?? [];
  const mcpRuntimeTools = mcp?.mcpRuntimeTools ?? [];

  const hasContent =
    agents.length > 0 ||
    memories.length > 0 ||
    credentials.length > 0 ||
    gateways.length > 0 ||
    mcpRuntimeTools.length > 0;

  return (
    <Box flexDirection="column">
      {/* Project name */}
      <Text bold color="cyan">
        {project.name}
      </Text>

      {/* Agents */}
      {agents.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Agents</SectionHeader>
          {agents.map(agent => {
            const statusInfo = agentStatuses?.[agent.name];
            const status = statusInfo?.error ? 'error' : statusInfo?.runtimeStatus;
            const color = statusInfo?.error ? 'red' : getStatusColor(status);
            return (
              <ResourceRow
                key={agent.name}
                icon={ICONS.agent}
                color="green"
                name={agent.name}
                status={status}
                statusColor={color}
              />
            );
          })}
        </Box>
      )}

      {/* Memories */}
      {memories.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Memories</SectionHeader>
          {memories.map(memory => {
            const strategies = memory.strategies.map(s => s.type).join(', ');
            return (
              <ResourceRow key={memory.name} icon={ICONS.memory} color="blue" name={memory.name} detail={strategies} />
            );
          })}
        </Box>
      )}

      {/* Credentials */}
      {credentials.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Credentials</SectionHeader>
          {credentials.map(credential => (
            <ResourceRow
              key={credential.name}
              icon={ICONS.credential}
              color="yellow"
              name={credential.name}
              detail={credential.type.replace('CredentialProvider', '')}
            />
          ))}
        </Box>
      )}

      {/* MCP Gateways */}
      {gateways.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Gateways</SectionHeader>
          {gateways.map(gateway => {
            const targets = gateway.targets ?? [];
            const tools = targets.flatMap(t => t.toolDefinitions ?? []);
            return (
              <Box key={gateway.name} flexDirection="column">
                <ResourceRow
                  icon={ICONS.gateway}
                  color="magenta"
                  name={gateway.name}
                  detail={tools.length > 0 ? `${tools.length} tools` : undefined}
                />
                {tools.map(tool => (
                  <Text key={tool.name}>
                    {'    '}
                    <Text color="cyan">{ICONS.tool}</Text> {tool.name}
                  </Text>
                ))}
              </Box>
            );
          })}
        </Box>
      )}

      {/* MCP Runtime Tools */}
      {mcpRuntimeTools.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Runtime Tools</SectionHeader>
          {mcpRuntimeTools.map((tool: AgentCoreMcpRuntimeTool) => (
            <ResourceRow
              key={tool.name}
              icon={ICONS.runtime}
              color="cyan"
              name={tool.toolDefinition?.name ?? tool.name}
            />
          ))}
        </Box>
      )}

      {/* Empty state */}
      {!hasContent && <Text color="gray">{'\n'} No resources configured</Text>}

      {/* Legend */}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{'─'.repeat(50)}</Text>
        <Text>
          <Text color="green">{ICONS.agent}</Text> agent{'  '}
          <Text color="blue">{ICONS.memory}</Text> memory{'  '}
          <Text color="yellow">{ICONS.credential}</Text> credential
        </Text>
      </Box>
    </Box>
  );
}
