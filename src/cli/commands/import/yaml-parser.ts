import type { AuthorizerConfig, CustomClaimValidation, RuntimeAuthorizerType } from '../../../schema';
import { RUNTIME_TYPE_MAP } from './constants';
import type {
  ParsedStarterToolkitAgent,
  ParsedStarterToolkitConfig,
  ParsedStarterToolkitCredential,
  ParsedStarterToolkitMemory,
} from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Minimal YAML parser for the starter toolkit config.
 * Handles the simple key-value YAML format without needing a full YAML library.
 * Falls back to JSON.parse for JSON-format configs.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  // Try JSON first
  try {
    return JSON.parse(content) as Record<string, unknown>;
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

    // Handle list items (- value or - key: value)
    if (trimmed.startsWith('- ')) {
      let parentEntry = findParent(stack, indent);
      let parentObj = parentEntry.obj;
      let keys = Object.keys(parentObj);
      let lastKey = keys[keys.length - 1];

      // If parent is an empty object (created from "key:" with no value), go up one
      // level and replace it with an array. This handles "credential_providers:\n  - name: X".
      if (!lastKey && Object.keys(parentObj).length === 0 && stack.length > 1) {
        stack.pop();
        parentEntry = stack[stack.length - 1]!;
        parentObj = parentEntry.obj;
        keys = Object.keys(parentObj);
        lastKey = keys[keys.length - 1];
      }

      if (lastKey) {
        if (!Array.isArray(parentObj[lastKey])) {
          parentObj[lastKey] = [];
        }
        const itemContent = trimmed.slice(2).trim();
        const itemColonIdx = itemContent.indexOf(':');
        if (itemColonIdx > 0 && !itemContent.startsWith('http')) {
          // List item is a key-value pair (e.g., "- name: Foo") — start a new object
          const itemObj: Record<string, unknown> = {};
          const itemKey = itemContent.slice(0, itemColonIdx).trim();
          const itemVal = itemContent.slice(itemColonIdx + 1).trim();
          itemObj[itemKey] = itemVal === '' ? {} : parseYamlValue(itemVal);
          (parentObj[lastKey] as unknown[]).push(itemObj);
          // Push onto stack so subsequent indented lines go into this object.
          // Use the same indent as the "- " line so that lines indented further
          // (e.g., arn: at indent+2) become children, while the next "- " at the
          // same indent triggers findParent to pop this item and start a new one.
          stack.push({ indent, obj: itemObj });
        } else {
          (parentObj[lastKey] as unknown[]).push(parseYamlValue(itemContent));
        }
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
 * Extract authorizer config from the YAML `authorizer_configuration` field.
 * Starter toolkit uses `customJWTAuthorizer` (capital JWT); CLI schema uses `customJwtAuthorizer` (lowercase jwt).
 */
function extractAuthorizerConfig(
  raw: unknown
): Pick<ParsedStarterToolkitAgent, 'authorizerType' | 'authorizerConfiguration'> {
  if (raw == null || raw === 'null' || typeof raw !== 'object') return {};

  const authConfig = raw as Record<string, unknown>;
  // Starter toolkit key is `customJWTAuthorizer` (capital JWT)
  const jwtRaw = authConfig.customJWTAuthorizer as Record<string, unknown> | undefined;
  if (!jwtRaw || typeof jwtRaw !== 'object') return {};

  const discoveryUrl = jwtRaw.discoveryUrl as string | undefined;
  if (!discoveryUrl) return {};

  const customJwtAuthorizer: AuthorizerConfig['customJwtAuthorizer'] = {
    discoveryUrl,
    ...(Array.isArray(jwtRaw.allowedAudience) ? { allowedAudience: jwtRaw.allowedAudience as string[] } : {}),
    ...(Array.isArray(jwtRaw.allowedClients) ? { allowedClients: jwtRaw.allowedClients as string[] } : {}),
    ...(Array.isArray(jwtRaw.allowedScopes) ? { allowedScopes: jwtRaw.allowedScopes as string[] } : {}),
    ...(Array.isArray(jwtRaw.customClaims) ? { customClaims: jwtRaw.customClaims as CustomClaimValidation[] } : {}),
  };

  return {
    authorizerType: 'CUSTOM_JWT' as RuntimeAuthorizerType,
    authorizerConfiguration: { customJwtAuthorizer },
  };
}

/**
 * Parse a .bedrock_agentcore.yaml file into our internal representation.
 */
export function parseStarterToolkitYaml(filePath: string): ParsedStarterToolkitConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = parseSimpleYaml(content);
  const yamlDir = path.dirname(path.resolve(filePath));

  const agents: ParsedStarterToolkitAgent[] = [];
  const memories: ParsedStarterToolkitMemory[] = [];
  const credentials: ParsedStarterToolkitCredential[] = [];
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
          account: String((awsConfig.account as string) ?? ''),
          region: String((awsConfig.region as string) ?? ''),
        };
      }

      // Map deployment_type
      const deploymentType = String((agentConfig.deployment_type as string) ?? 'container');
      const build = deploymentType === 'direct_code_deploy' ? 'CodeZip' : 'Container';

      // Map runtime_type
      const rawRuntimeType = String((agentConfig.runtime_type as string) ?? 'PYTHON_3_12');
      const runtimeVersion = RUNTIME_TYPE_MAP[rawRuntimeType] ?? 'PYTHON_3_12';

      // Map network mode
      const networkMode = String((networkConfig?.network_mode as string) ?? 'PUBLIC') as 'PUBLIC' | 'VPC';
      const networkModeConfig = networkConfig?.network_mode_config as Record<string, unknown> | undefined;

      // Map protocol
      const protocol = String((protocolConfig?.server_protocol as string) ?? 'HTTP') as 'HTTP' | 'MCP' | 'A2A';

      agents.push({
        name: String((agentConfig.name as string) ?? agentKey),
        entrypoint: String((agentConfig.entrypoint as string) ?? 'main.py'),
        build,
        runtimeVersion,
        language: (agentConfig.language as 'python' | 'typescript') ?? 'python',
        sourcePath: agentConfig.source_path
          ? path.resolve(yamlDir, String(agentConfig.source_path as string))
          : undefined,
        networkMode,
        networkConfig:
          networkMode === 'VPC' && networkModeConfig
            ? {
                subnets: Array.isArray(networkModeConfig.subnets) ? (networkModeConfig.subnets as string[]) : [],
                securityGroups: Array.isArray(networkModeConfig.security_groups)
                  ? (networkModeConfig.security_groups as string[])
                  : [],
              }
            : undefined,
        protocol,
        enableOtel: (obsConfig?.enabled as boolean) ?? true,
        physicalAgentId: bedrockConfig?.agent_id as string | undefined,
        physicalAgentArn: bedrockConfig?.agent_arn as string | undefined,
        ...extractAuthorizerConfig(agentConfig.authorizer_configuration),
        executionRoleArn: (awsConfig?.execution_role as string) || undefined,
      });

      // Extract memory config per agent — ensure mode is a non-empty string
      // (the simple YAML parser turns bare "mode:" into an empty object {})
      if (
        memoryConfig &&
        typeof memoryConfig.mode === 'string' &&
        memoryConfig.mode !== 'NO_MEMORY' &&
        memoryConfig.mode
      ) {
        const memName =
          (memoryConfig.memory_name as string) ?? `${String((agentConfig.name as string) ?? agentKey)}_memory`;
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

      // Extract credential providers (OAuth and API key)
      const identityConfig = agentConfig.identity as Record<string, unknown> | undefined;
      if (identityConfig) {
        const providers = identityConfig.credential_providers as Record<string, unknown>[] | undefined;
        if (Array.isArray(providers)) {
          for (const provider of providers) {
            const providerName = provider.name as string | undefined;
            if (providerName && !credentials.find(c => c.name === providerName)) {
              credentials.push({ name: providerName, providerType: 'oauth' });
            }
          }
        }
      }

      // Extract API key credential provider
      const apiKeyCredName = agentConfig.api_key_credential_provider_name as string | undefined;
      if (apiKeyCredName && !credentials.find(c => c.name === apiKeyCredName)) {
        credentials.push({ name: apiKeyCredName, providerType: 'api_key' });
      }
    }
  }

  return { defaultAgent, agents, memories, credentials, awsTarget };
}
