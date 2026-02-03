import type {
  AgentCoreAgentInvocation,
  AgentCoreDeployedState,
  AgentCoreGateway,
  AgentCoreMcpRuntimeTool,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
} from '../../../schema';
import { Box, Text } from 'ink';
import React from 'react';

const RESOURCE_ICONS = {
  agent: '●',
  gateway: '◆',
  tool: '⚙',
  memory: '■',
  runtime: '▶',
  agentLink: '↗',
} as const;

const LEGEND_LINE_WIDTH = 50;

const LEGEND_ITEMS: { icon: keyof typeof RESOURCE_ICONS; label: string; color: string }[] = [
  { icon: 'gateway', label: 'gateway', color: 'yellow' },
  { icon: 'tool', label: 'tool', color: 'magenta' },
  { icon: 'memory', label: 'memory', color: 'blue' },
  { icon: 'runtime', label: 'runtime', color: 'magenta' },
  { icon: 'agentLink', label: 'agent', color: 'cyan' },
];

function LegendRows() {
  const rows: (typeof LEGEND_ITEMS)[number][][] = [];
  let currentRow: (typeof LEGEND_ITEMS)[number][] = [];
  let currentLen = 0;

  for (const item of LEGEND_ITEMS) {
    // icon (1) + space (1) + label + space (1) between items
    const itemLen = 1 + 1 + item.label.length + 1;
    if (currentLen + itemLen > LEGEND_LINE_WIDTH && currentRow.length > 0) {
      rows.push(currentRow);
      currentRow = [];
      currentLen = 0;
    }
    currentRow.push(item);
    currentLen += itemLen;
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return (
    <>
      {rows.map((row, rowIdx) => (
        <Text key={rowIdx}>
          {row.map((item, idx) => (
            <Text key={item.icon}>
              <Text color={item.color}>{RESOURCE_ICONS[item.icon]}</Text> {item.label}
              {idx < row.length - 1 ? ' ' : ''}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

export interface AgentStatusInfo {
  runtimeStatus?: string; // "READY", "ACTIVE", etc.
  error?: string;
}

interface ResourceGraphProps {
  project: AgentCoreProjectSpec;
  mcp?: AgentCoreMcpSpec;
  /** If provided, only show this agent */
  agentName?: string;
  /** Runtime status info per agent name */
  agentStatuses?: Record<string, AgentStatusInfo>;
  /** Deployed agent state per agent name (for showing ARNs/IDs) */
  deployedAgents?: Record<string, AgentCoreDeployedState>;
}

function GatewayTools({ gateway, isLast, indent }: { gateway: AgentCoreGateway; isLast: boolean; indent: string }) {
  const targets = gateway.targets ?? [];
  const branch = isLast ? '└─' : '├─';
  const childIndent = indent + (isLast ? '      ' : '│     ');

  // Flatten all tool definitions from all targets
  const allTools = targets.flatMap(target => target.toolDefinitions ?? []);

  return (
    <Box flexDirection="column">
      <Text>
        {indent}
        {branch} <Text color="yellow">{RESOURCE_ICONS.gateway}</Text> {gateway.name}
      </Text>
      {allTools.map((toolDef, idx) => {
        const toolBranch = idx === allTools.length - 1 ? '└─' : '├─';
        return (
          <Text key={toolDef.name + idx}>
            {childIndent}
            {toolBranch} <Text color="magenta">{RESOURCE_ICONS.tool}</Text> {toolDef.name}
          </Text>
        );
      })}
    </Box>
  );
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

export function ResourceGraph({ project, mcp, agentName, agentStatuses, deployedAgents }: ResourceGraphProps) {
  const allAgents = project.agents ?? [];
  const agents = agentName ? allAgents.filter(a => a.name === agentName) : allAgents;
  const gateways = mcp?.agentCoreGateways ?? [];
  const mcpRuntimeTools = mcp?.mcpRuntimeTools ?? [];

  // Build gateway lookup map
  const gatewayMap = new Map(gateways.map(gw => [gw.name, gw]));

  // Track used gateways
  const usedGateways = new Set<string>();

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {project.name}
      </Text>

      {/* Each agent as a tree */}
      {agents.map(agent => {
        const agentGateways = (agent.mcpProviders ?? [])
          .filter(p => p.type === 'AgentCoreGateway' && p.gatewayName)
          .map(p => gatewayMap.get(p.gatewayName))
          .filter((gw): gw is AgentCoreGateway => gw !== undefined);
        agentGateways.forEach(gw => usedGateways.add(gw.name));

        const memNames = (agent.memoryProviders ?? []).map(m => m.name);

        // Extract agent-to-agent remote tool relationships
        const agentLinks = (agent.remoteTools ?? []).filter(
          (t): t is AgentCoreAgentInvocation => t.type === 'AgentCoreAgentInvocation'
        );

        const totalItems = agentGateways.length + memNames.length + agentLinks.length;

        const statusInfo = agentStatuses?.[agent.name];
        const statusText = statusInfo?.error ? 'error' : statusInfo?.runtimeStatus;
        // Only show deployed state if we didn't get an error (error likely means resource doesn't exist)
        const deployedState = statusInfo?.error ? undefined : deployedAgents?.[agent.name];

        return (
          <Box key={agent.name} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="green" bold>
                {RESOURCE_ICONS.agent} {agent.name}
              </Text>
              {statusText && (
                <Text color={statusInfo?.error ? 'red' : getStatusColor(statusText)}> [{statusText}]</Text>
              )}
            </Text>
            {deployedState && (
              <Box flexDirection="column" marginLeft={2}>
                <Text dimColor>arn: {deployedState.runtimeArn}</Text>
                {deployedState.memoryIds && deployedState.memoryIds.length > 0 && (
                  <Text dimColor>memory: {deployedState.memoryIds.join(', ')}</Text>
                )}
              </Box>
            )}
            {agentGateways.map((gw, idx) => (
              <GatewayTools key={gw.name} gateway={gw} isLast={idx === totalItems - 1} indent="    " />
            ))}
            {memNames.map((name, idx) => {
              const itemIdx = agentGateways.length + idx;
              const isLast = itemIdx === totalItems - 1;
              return (
                <Text key={name}>
                  {'    '}
                  {isLast ? '└─' : '├─'} <Text color="blue">{RESOURCE_ICONS.memory}</Text> {name}
                </Text>
              );
            })}
            {agentLinks.map((link, idx) => {
              const itemIdx = agentGateways.length + memNames.length + idx;
              const isLast = itemIdx === totalItems - 1;
              return (
                <Text key={link.name}>
                  {'    '}
                  {isLast ? '└─' : '├─'} <Text color="cyan">{RESOURCE_ICONS.agentLink}</Text> {link.targetAgentName}
                </Text>
              );
            })}
            {totalItems === 0 && <Text dimColor> (no providers)</Text>}
          </Box>
        );
      })}

      {/* Unattached resources section */}
      {(gateways.some(gw => !usedGateways.has(gw.name)) || mcpRuntimeTools.length > 0) && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>─ Unattached ─</Text>
          {gateways
            .filter(gw => !usedGateways.has(gw.name))
            .map((gw, idx, arr) => (
              <GatewayTools
                key={gw.name}
                gateway={gw}
                isLast={idx === arr.length - 1 && mcpRuntimeTools.length === 0}
                indent=""
              />
            ))}
          {mcpRuntimeTools.map((t: AgentCoreMcpRuntimeTool, idx: number) => {
            const isLast = idx === mcpRuntimeTools.length - 1;
            return (
              <Text key={t.name}>
                {isLast ? '└─' : '├─'} <Text color="magenta">{RESOURCE_ICONS.runtime}</Text>{' '}
                {t.toolDefinition?.name ?? t.name}
              </Text>
            );
          })}
        </Box>
      )}

      {/* Legend */}
      <Box marginTop={1} flexDirection="column">
        <Text>{'─'.repeat(LEGEND_LINE_WIDTH)}</Text>
        <LegendRows />
      </Box>
    </Box>
  );
}
