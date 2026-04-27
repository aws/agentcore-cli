import type {
  AgentCoreGatewayTarget,
  AgentCoreMcpRuntimeTool,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
} from '../../../schema';
import type { ResourceStatusEntry } from '../../commands/status/action';
import { DEPLOYMENT_STATE_COLORS, DEPLOYMENT_STATE_LABELS } from '../../commands/status/constants';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

const ICONS = {
  agent: '●',
  memory: '■',
  credential: '◇',
  gateway: '◆',
  tool: '⚙',
  runtime: '▶',
  evaluator: '✦',
  'online-eval': '↻',
  'policy-engine': '▣',
  policy: '▢',
} as const;

interface ResourceGraphProps {
  project: AgentCoreProjectSpec;
  mcp?: AgentCoreMcpSpec & { unassignedTargets?: AgentCoreGatewayTarget[] };
  agentName?: string;
  resourceStatuses?: ResourceStatusEntry[];
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

function getDeploymentBadge(
  state: ResourceStatusEntry['deploymentState']
): { text: string; color: string } | undefined {
  if (state === 'pending-removal') return undefined;
  const label = DEPLOYMENT_STATE_LABELS[state];
  const color = DEPLOYMENT_STATE_COLORS[state];
  return label && color ? { text: label, color } : undefined;
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
  deploymentState,
  identifier,
  invocationUrl,
}: {
  icon: string;
  color: string;
  name: string;
  detail?: string;
  status?: string;
  statusColor?: string;
  deploymentState?: ResourceStatusEntry['deploymentState'];
  identifier?: string;
  invocationUrl?: string;
}) {
  const badge = deploymentState ? getDeploymentBadge(deploymentState) : undefined;

  return (
    <Box flexDirection="column">
      <Text>
        {'  '}
        <Text color={color}>{icon}</Text> {name}
        {detail && <Text color="gray"> {detail}</Text>}
        {status && <Text color={statusColor ?? 'gray'}> [{status}]</Text>}
        {badge && <Text color={badge.color}> [{badge.text}]</Text>}
      </Text>
      {identifier && (
        <Text dimColor>
          {'      '}ID: {identifier}
        </Text>
      )}
      {invocationUrl && (
        <Text dimColor>
          {'      '}URL: {invocationUrl}
        </Text>
      )}
    </Box>
  );
}

export function getTargetDisplayText(target: AgentCoreGatewayTarget): string {
  if (target.targetType === 'mcpServer' && target.endpoint) return target.endpoint;
  if (target.targetType === 'apiGateway' && target.apiGateway)
    return `${target.apiGateway.restApiId}/${target.apiGateway.stage}`;
  if (target.targetType === 'lambdaFunctionArn' && target.lambdaFunctionArn) return target.lambdaFunctionArn.lambdaArn;
  return target.name;
}

export function ResourceGraph({ project, mcp, agentName, resourceStatuses }: ResourceGraphProps) {
  const allAgents = project.runtimes ?? [];
  const agents = agentName ? allAgents.filter(a => a.name === agentName) : allAgents;
  const memories = project.memories ?? [];
  const credentials = project.credentials ?? [];
  const evaluators = project.evaluators ?? [];
  const onlineEvalConfigs = project.onlineEvalConfigs ?? [];
  const gateways = mcp?.agentCoreGateways ?? [];
  const mcpRuntimeTools = mcp?.mcpRuntimeTools ?? [];
  const unassignedTargets = mcp?.unassignedTargets ?? [];
  const policyEngines = project.policyEngines ?? [];

  // Build lookup map and collect pending-removal resources in a single pass
  const { statusMap, pendingRemovals } = useMemo(() => {
    const map = new Map<string, ResourceStatusEntry>();
    const pending: ResourceStatusEntry[] = [];

    if (resourceStatuses) {
      for (const entry of resourceStatuses) {
        const key =
          entry.resourceType === 'policy' && entry.detail
            ? `${entry.resourceType}:${entry.detail}/${entry.name}`
            : `${entry.resourceType}:${entry.name}`;
        map.set(key, entry);
        if (entry.deploymentState === 'pending-removal') {
          pending.push(entry);
        }
      }
    }

    return { statusMap: map, pendingRemovals: pending };
  }, [resourceStatuses]);

  const hasContent =
    agents.length > 0 ||
    memories.length > 0 ||
    credentials.length > 0 ||
    evaluators.length > 0 ||
    onlineEvalConfigs.length > 0 ||
    gateways.length > 0 ||
    policyEngines.length > 0 ||
    mcpRuntimeTools.length > 0 ||
    unassignedTargets.length > 0 ||
    pendingRemovals.length > 0;

  return (
    <Box flexDirection="column">
      {/* Project name — only when not embedded in a screen with its own header */}
      {!resourceStatuses && (
        <Text bold color="cyan">
          {project.name}
        </Text>
      )}

      {/* Agents */}
      {agents.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Agents</SectionHeader>
          {agents.map(agent => {
            const rsEntry = statusMap.get(`agent:${agent.name}`);
            const runtimeStatus = rsEntry?.error ? 'error' : rsEntry?.detail;
            const runtimeStatusColor = rsEntry?.error ? 'red' : getStatusColor(runtimeStatus);
            return (
              <ResourceRow
                key={agent.name}
                icon={ICONS.agent}
                color="green"
                name={agent.name}
                status={runtimeStatus}
                statusColor={runtimeStatusColor}
                deploymentState={rsEntry?.deploymentState}
                identifier={rsEntry?.identifier}
                invocationUrl={rsEntry?.invocationUrl}
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
            const rsEntry = statusMap.get(`memory:${memory.name}`);
            return (
              <ResourceRow
                key={memory.name}
                icon={ICONS.memory}
                color="blue"
                name={memory.name}
                detail={rsEntry?.detail ?? strategies}
                deploymentState={rsEntry?.deploymentState}
                identifier={rsEntry?.identifier}
              />
            );
          })}
        </Box>
      )}

      {/* Credentials */}
      {credentials.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Credentials</SectionHeader>
          {credentials.map(credential => {
            const rsEntry = statusMap.get(`credential:${credential.name}`);
            return (
              <ResourceRow
                key={credential.name}
                icon={ICONS.credential}
                color="yellow"
                name={credential.name}
                detail={rsEntry?.detail ?? credential.authorizerType.replace('CredentialProvider', '')}
                deploymentState={rsEntry?.deploymentState}
                identifier={rsEntry?.identifier}
              />
            );
          })}
        </Box>
      )}

      {/* Evaluators */}
      {evaluators.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Evaluators</SectionHeader>
          {evaluators.map(evaluator => {
            const rsEntry = statusMap.get(`evaluator:${evaluator.name}`);
            const evalStatus = rsEntry?.error ? 'error' : undefined;
            const evalStatusColor = rsEntry?.error ? 'red' : undefined;
            return (
              <ResourceRow
                key={evaluator.name}
                icon={ICONS.evaluator}
                color="cyan"
                name={evaluator.name}
                detail={rsEntry?.detail ?? `${evaluator.level} — LLM-as-a-Judge`}
                status={evalStatus}
                statusColor={evalStatusColor}
                deploymentState={rsEntry?.deploymentState}
                identifier={rsEntry?.identifier}
              />
            );
          })}
        </Box>
      )}

      {/* Online Eval Configs */}
      {onlineEvalConfigs.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Online Eval Configs</SectionHeader>
          {onlineEvalConfigs.map(config => {
            const rsEntry = statusMap.get(`online-eval:${config.name}`);
            const defaultDetail = `${config.evaluators.length} evaluator${config.evaluators.length !== 1 ? 's' : ''} — ${config.samplingRate}% sampling`;
            return (
              <ResourceRow
                key={config.name}
                icon={ICONS['online-eval']}
                color="magenta"
                name={config.name}
                detail={rsEntry?.detail ?? defaultDetail}
                status={rsEntry?.error ? 'error' : undefined}
                statusColor={rsEntry?.error ? 'red' : undefined}
                deploymentState={rsEntry?.deploymentState}
                identifier={rsEntry?.identifier}
              />
            );
          })}
        </Box>
      )}

      {/* Removed locally — still deployed in AWS, will be torn down on next deploy */}
      {pendingRemovals.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Removed Locally</SectionHeader>
          <Text color="gray"> Still deployed — run `deploy` to tear down</Text>
          {pendingRemovals.map(entry => (
            <ResourceRow
              key={`removed-${entry.resourceType}-${entry.name}`}
              icon={ICONS[entry.resourceType]}
              color="red"
              name={entry.name}
              identifier={entry.identifier}
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
            const rsEntry = statusMap.get(`gateway:${gateway.name}`);
            return (
              <Box key={gateway.name} flexDirection="column">
                <ResourceRow
                  icon={ICONS.gateway}
                  color="magenta"
                  name={gateway.name}
                  detail={rsEntry?.detail}
                  deploymentState={rsEntry?.deploymentState}
                  identifier={rsEntry?.identifier}
                />
                {targets.map(target => {
                  const displayText = getTargetDisplayText(target);
                  return (
                    <Text key={target.name}>
                      {'    '}
                      <Text color="cyan">{ICONS.tool}</Text> {displayText}
                      {(target.targetType === 'apiGateway' ||
                        target.targetType === 'lambdaFunctionArn' ||
                        (target.targetType === 'mcpServer' && target.endpoint)) && (
                        <Text color="gray"> [{target.targetType}]</Text>
                      )}
                    </Text>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Policy Engines and Policies */}
      {policyEngines.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>Policy Engines</SectionHeader>
          {policyEngines.map(engine => {
            const rsEntry = statusMap.get(`policy-engine:${engine.name}`);
            return (
              <Box key={engine.name} flexDirection="column">
                <ResourceRow
                  icon={ICONS['policy-engine']}
                  color="red"
                  name={engine.name}
                  detail={rsEntry?.detail}
                  deploymentState={rsEntry?.deploymentState}
                  identifier={rsEntry?.identifier}
                />
                {engine.policies.map(policy => {
                  const policyEntry = statusMap.get(`policy:${engine.name}/${policy.name}`);
                  return (
                    <Text key={policy.name}>
                      {'    '}
                      <Text color="red">{ICONS.policy}</Text> {policy.name}
                      {policyEntry?.deploymentState && (
                        <Text color={DEPLOYMENT_STATE_COLORS[policyEntry.deploymentState]}>
                          {' '}
                          [{DEPLOYMENT_STATE_LABELS[policyEntry.deploymentState]}]
                        </Text>
                      )}
                    </Text>
                  );
                })}
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

      {/* Unassigned Targets */}
      {unassignedTargets.length > 0 && (
        <Box flexDirection="column">
          <SectionHeader>⚠ Unassigned Targets</SectionHeader>
          {unassignedTargets.map((target, idx) => {
            const displayText = getTargetDisplayText(target);
            return <ResourceRow key={idx} icon="⚠" color="yellow" name={displayText} detail={target.targetType} />;
          })}
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
          <Text color="yellow">{ICONS.credential}</Text> credential{'  '}
          <Text color="cyan">{ICONS.evaluator}</Text> evaluator{'  '}
          <Text color="magenta">{ICONS['online-eval']}</Text> online-eval{'  '}
          <Text color="magenta">{ICONS.gateway}</Text> gateway{'  '}
          <Text color="red">{ICONS['policy-engine']}</Text> policy engine
        </Text>
      </Box>
    </Box>
  );
}
