import { RUNTIME_TYPE_MAP } from './constants';
import type {
  ParsedStarterToolkitAgent,
  ParsedStarterToolkitConfig,
  ParsedStarterToolkitMemory,
} from './types';
import * as fs from 'node:fs';

/**
 * Minimal YAML parser for the starter toolkit config.
 * Handles the simple key-value YAML format without needing a full YAML library.
 * Falls back to JSON.parse for JSON-format configs.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  // Try JSON first
  try {
    return JSON.parse(content);
  } catch {
    // Not JSON, parse YAML
  }

  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];

  for (const rawLine of lines) {
    // Skip empty lines and comments
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Calculate indent level
    const indent = rawLine.search(/\S/);

    // Handle list items (- value)
    if (trimmed.startsWith('- ')) {
      const parentEntry = findParent(stack, indent);
      const parentObj = parentEntry.obj;
      // Find the last key that was added to parent
      const keys = Object.keys(parentObj);
      const lastKey = keys[keys.length - 1];
      if (lastKey) {
        if (!Array.isArray(parentObj[lastKey])) {
          parentObj[lastKey] = [];
        }
        (parentObj[lastKey] as unknown[]).push(parseYamlValue(trimmed.slice(2).trim()));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    // Pop stack to find correct parent
    const parent = findParent(stack, indent);

    if (valueStr === '' || valueStr === '|') {
      // Nested object
      const child: Record<string, unknown> = {};
      parent.obj[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent.obj[key] = parseYamlValue(valueStr);
    }
  }

  return result;
}

function findParent(
  stack: { indent: number; obj: Record<string, unknown> }[],
  indent: number
): { indent: number; obj: Record<string, unknown> } {
  while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
    stack.pop();
  }
  return stack[stack.length - 1]!;
}

function parseYamlValue(value: string): unknown {
  if (value === 'null' || value === '~' || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Check for quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  // Check for numbers
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

/**
 * Parse a .bedrock_agentcore.yaml file into our internal representation.
 */
export function parseStarterToolkitYaml(filePath: string): ParsedStarterToolkitConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = parseSimpleYaml(content) as Record<string, unknown>;

  const agents: ParsedStarterToolkitAgent[] = [];
  const memories: ParsedStarterToolkitMemory[] = [];
  let awsTarget: { account?: string; region?: string } = {};

  const defaultAgent = raw.default_agent as string | undefined;
  const agentsMap = raw.agents as Record<string, Record<string, unknown>> | undefined;

  if (agentsMap) {
    for (const [agentKey, agentConfig] of Object.entries(agentsMap)) {
      const awsConfig = agentConfig.aws as Record<string, unknown> | undefined;
      const bedrockConfig = agentConfig.bedrock_agentcore as Record<string, unknown> | undefined;
      const memoryConfig = agentConfig.memory as Record<string, unknown> | undefined;
      const networkConfig = awsConfig?.network_configuration as Record<string, unknown> | undefined;
      const protocolConfig = awsConfig?.protocol_configuration as Record<string, unknown> | undefined;
      const obsConfig = awsConfig?.observability as Record<string, unknown> | undefined;

      // Extract AWS target from first agent
      if (awsConfig && (!awsTarget.account || !awsTarget.region)) {
        awsTarget = {
          account: String(awsConfig.account ?? ''),
          region: String(awsConfig.region ?? ''),
        };
      }

      // Map deployment_type
      const deploymentType = String(agentConfig.deployment_type ?? 'container');
      const build = deploymentType === 'direct_code_deploy' ? 'CodeZip' : 'Container';

      // Map runtime_type
      const rawRuntimeType = String(agentConfig.runtime_type ?? 'PYTHON_3_12');
      const runtimeVersion = RUNTIME_TYPE_MAP[rawRuntimeType] ?? 'python3.12';

      // Map network mode
      const networkMode = String(networkConfig?.network_mode ?? 'PUBLIC') as 'PUBLIC' | 'VPC';
      const networkModeConfig = networkConfig?.network_mode_config as Record<string, unknown> | undefined;

      // Map protocol
      const protocol = String(protocolConfig?.server_protocol ?? 'HTTP') as 'HTTP' | 'MCP' | 'A2A';

      agents.push({
        name: String(agentConfig.name ?? agentKey),
        entrypoint: String(agentConfig.entrypoint ?? 'main.py'),
        build,
        runtimeVersion,
        language: (agentConfig.language as 'python' | 'typescript') ?? 'python',
        sourcePath: agentConfig.source_path as string | undefined,
        networkMode,
        networkConfig:
          networkMode === 'VPC' && networkModeConfig
            ? {
                subnets: (networkModeConfig.subnets as string[]) ?? [],
                securityGroups: (networkModeConfig.security_groups as string[]) ?? [],
              }
            : undefined,
        protocol,
        enableOtel: (obsConfig?.enabled as boolean) ?? true,
        physicalAgentId: bedrockConfig?.agent_id as string | undefined,
        physicalAgentArn: bedrockConfig?.agent_arn as string | undefined,
      });

      // Extract memory config per agent
      if (memoryConfig && memoryConfig.mode !== 'NO_MEMORY' && memoryConfig.mode) {
        const memName = (memoryConfig.memory_name as string) ?? `${agentConfig.name ?? agentKey}_memory`;
        // Avoid duplicate memories
        if (!memories.find(m => m.name === memName)) {
          memories.push({
            name: memName,
            mode: memoryConfig.mode as 'STM_ONLY' | 'STM_AND_LTM',
            eventExpiryDays: (memoryConfig.event_expiry_days as number) ?? 30,
            physicalMemoryId: memoryConfig.memory_id as string | undefined,
            physicalMemoryArn: memoryConfig.memory_arn as string | undefined,
          });
        }
      }
    }
  }

  return { defaultAgent, agents, memories, awsTarget };
}
