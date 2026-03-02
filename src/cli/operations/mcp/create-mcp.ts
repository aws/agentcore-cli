import { ConfigIO, requireConfigRoot } from '../../../lib';
import type {
  AgentCoreCliMcpDefs,
  AgentCoreGateway,
  AgentCoreGatewayTarget,
  AgentCoreMcpSpec,
  DirectoryPath,
  FilePath,
} from '../../../schema';
import { AgentCoreCliMcpDefsSchema, ToolDefinitionSchema } from '../../../schema';
import { getTemplateToolDefinitions, renderGatewayTargetTemplate } from '../../templates/GatewayTargetRenderer';
import type { AddGatewayConfig, AddGatewayTargetConfig } from '../../tui/screens/mcp/types';
import { DEFAULT_HANDLER, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from '../../tui/screens/mcp/types';
import { createCredential } from '../identity/create-identity';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

const MCP_DEFS_FILE = 'mcp-defs.json';

export interface CreateGatewayResult {
  name: string;
}

export interface CreateToolResult {
  mcpDefsPath: string;
  toolName: string;
  projectPath: string;
}

function resolveMcpDefsPath(): string {
  return join(requireConfigRoot(), MCP_DEFS_FILE);
}

async function readMcpDefs(filePath: string): Promise<AgentCoreCliMcpDefs> {
  if (!existsSync(filePath)) {
    return { tools: {} };
  }

  const raw = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const result = AgentCoreCliMcpDefsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Invalid mcp-defs.json. Fix it before adding a new gateway target.');
  }
  return result.data;
}

async function writeMcpDefs(filePath: string, data: AgentCoreCliMcpDefs): Promise<void> {
  const configRoot = requireConfigRoot();
  await mkdir(configRoot, { recursive: true });
  const content = JSON.stringify(data, null, 2);
  await writeFile(filePath, content, 'utf-8');
}

export function computeDefaultGatewayEnvVarName(gatewayName: string): string {
  const sanitized = gatewayName.toUpperCase().replace(/-/g, '_');
  return `AGENTCORE_GATEWAY_${sanitized}_URL`;
}

/**
 * Builds authorizer configuration from wizard config.
 * Returns undefined if not using CUSTOM_JWT or no JWT config provided.
 */
function buildAuthorizerConfiguration(config: AddGatewayConfig): AgentCoreGateway['authorizerConfiguration'] {
  if (config.authorizerType !== 'CUSTOM_JWT' || !config.jwtConfig) {
    return undefined;
  }

  return {
    customJwtAuthorizer: {
      discoveryUrl: config.jwtConfig.discoveryUrl,
      allowedAudience: config.jwtConfig.allowedAudience,
      allowedClients: config.jwtConfig.allowedClients,
      ...(config.jwtConfig.allowedScopes?.length && { allowedScopes: config.jwtConfig.allowedScopes }),
    },
  };
}

/**
 * Get list of unassigned targets from MCP spec.
 */
export async function getUnassignedTargets(): Promise<AgentCoreGatewayTarget[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
    return mcpSpec.unassignedTargets ?? [];
  } catch {
    return [];
  }
}

/**
 * Get list of existing gateway names from project spec.
 */
export async function getExistingGateways(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
    return mcpSpec.agentCoreGateways.map(g => g.name);
  } catch {
    return [];
  }
}

/**
 * Get list of agent names from project spec.
 */
export async function getAvailableAgents(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agents.map(agent => agent.name);
  } catch {
    return [];
  }
}

/**
 * Get list of existing tool names from MCP spec (both MCP runtime and gateway targets).
 */
export async function getExistingToolNames(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
    const toolNames: string[] = [];

    // MCP runtime tools
    for (const tool of mcpSpec.mcpRuntimeTools ?? []) {
      toolNames.push(tool.name);
    }

    // Gateway targets
    for (const gateway of mcpSpec.agentCoreGateways) {
      for (const target of gateway.targets) {
        for (const toolDef of target.toolDefinitions ?? []) {
          toolNames.push(toolDef.name);
        }
      }
    }

    return toolNames;
  } catch {
    return [];
  }
}

export function computeDefaultMcpRuntimeEnvVarName(runtimeName: string): string {
  const sanitized = runtimeName.toUpperCase().replace(/-/g, '_');
  return `AGENTCORE_MCPRUNTIME_${sanitized}_URL`;
}

/**
 * Create a gateway (no tools attached).
 */
export async function createGatewayFromWizard(config: AddGatewayConfig): Promise<CreateGatewayResult> {
  const configIO = new ConfigIO();
  const mcpSpec: AgentCoreMcpSpec = configIO.configExists('mcp')
    ? await configIO.readMcpSpec()
    : { agentCoreGateways: [] };

  // Check if gateway already exists
  if (mcpSpec.agentCoreGateways.some(g => g.name === config.name)) {
    throw new Error(`Gateway "${config.name}" already exists.`);
  }

  // Collect selected unassigned targets
  const selectedTargets: AgentCoreGatewayTarget[] = [];
  if (config.selectedTargets && config.selectedTargets.length > 0) {
    const unassignedTargets = mcpSpec.unassignedTargets ?? [];
    for (const targetName of config.selectedTargets) {
      const target = unassignedTargets.find(t => t.name === targetName);
      if (target) {
        selectedTargets.push(target);
      }
    }
  }

  const gateway: AgentCoreGateway = {
    name: config.name,
    description: config.description,
    targets: selectedTargets,
    authorizerType: config.authorizerType,
    authorizerConfiguration: buildAuthorizerConfiguration(config),
  };

  mcpSpec.agentCoreGateways.push(gateway);

  // Remove selected targets from unassigned targets
  if (config.selectedTargets && config.selectedTargets.length > 0) {
    const selected = config.selectedTargets;
    mcpSpec.unassignedTargets = (mcpSpec.unassignedTargets ?? []).filter(t => !selected.includes(t.name));
  }

  await configIO.writeMcpSpec(mcpSpec);

  // Auto-create managed credential if agent OAuth credentials provided
  if (config.jwtConfig?.agentClientId && config.jwtConfig?.agentClientSecret) {
    const credName = `${config.name}-agent-oauth`;
    await createCredential({
      type: 'OAuthCredentialProvider',
      name: credName,
      discoveryUrl: config.jwtConfig.discoveryUrl,
      clientId: config.jwtConfig.agentClientId,
      clientSecret: config.jwtConfig.agentClientSecret,
      vendor: 'CustomOauth2',
      managed: true,
    });
  }

  return { name: config.name };
}

function validateGatewayTargetLanguage(language: string): asserts language is 'Python' | 'TypeScript' | 'Other' {
  if (language !== 'Python' && language !== 'TypeScript' && language !== 'Other') {
    throw new Error(`Gateway targets for language "${language}" are not yet supported.`);
  }
}

/**
 * Validate that a credential name exists in the project spec.
 */
async function validateCredentialName(credentialName: string): Promise<void> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  const credentialExists = project.credentials.some(c => c.name === credentialName);
  if (!credentialExists) {
    const availableCredentials = project.credentials.map(c => c.name);
    if (availableCredentials.length === 0) {
      throw new Error(
        `Credential "${credentialName}" not found. No credentials are configured. Add credentials using 'agentcore add identity'.`
      );
    }
    throw new Error(
      `Credential "${credentialName}" not found. Available credentials: ${availableCredentials.join(', ')}`
    );
  }
}

/**
 * Create an external MCP server target (existing endpoint).
 */
export async function createExternalGatewayTarget(config: AddGatewayTargetConfig): Promise<CreateToolResult> {
  if (!config.endpoint) {
    throw new Error('Endpoint URL is required for external MCP server targets.');
  }

  const configIO = new ConfigIO();
  const mcpSpec: AgentCoreMcpSpec = configIO.configExists('mcp')
    ? await configIO.readMcpSpec()
    : { agentCoreGateways: [], unassignedTargets: [] };

  const target: AgentCoreGatewayTarget = {
    name: config.name,
    targetType: 'mcpServer',
    endpoint: config.endpoint,
    toolDefinitions: [config.toolDefinition],
    ...(config.outboundAuth && { outboundAuth: config.outboundAuth }),
  };

  if (!config.gateway) {
    throw new Error(
      "Gateway is required. A gateway target must be attached to a gateway. Create a gateway first with 'agentcore add gateway'."
    );
  }

  const gateway = mcpSpec.agentCoreGateways.find(g => g.name === config.gateway);
  if (!gateway) {
    throw new Error(`Gateway "${config.gateway}" not found.`);
  }

  // Check for duplicate target name
  if (gateway.targets.some(t => t.name === config.name)) {
    throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
  }

  gateway.targets.push(target);

  await configIO.writeMcpSpec(mcpSpec);

  return { mcpDefsPath: '', toolName: config.name, projectPath: '' };
}

/**
 * Create a gateway target (behind gateway only).
 */
export async function createToolFromWizard(config: AddGatewayTargetConfig): Promise<CreateToolResult> {
  validateGatewayTargetLanguage(config.language);

  // Validate credential if outboundAuth is configured
  if (config.outboundAuth?.credentialName) {
    await validateCredentialName(config.outboundAuth.credentialName);
  }

  const configIO = new ConfigIO();
  const mcpSpec: AgentCoreMcpSpec = configIO.configExists('mcp')
    ? await configIO.readMcpSpec()
    : { agentCoreGateways: [] };

  // Get tool definitions based on host type
  // Lambda template has multiple predefined tools; AgentCoreRuntime uses the user-provided definition
  const toolDefs =
    config.host === 'Lambda' ? getTemplateToolDefinitions(config.name, config.host) : [config.toolDefinition];

  // Validate tool definitions
  for (const toolDef of toolDefs) {
    ToolDefinitionSchema.parse(toolDef);
  }

  // Behind gateway
  if (!config.gateway) {
    throw new Error('Gateway name is required for tools behind a gateway.');
  }

  const gateway = mcpSpec.agentCoreGateways.find(g => g.name === config.gateway);
  if (!gateway) {
    throw new Error(`Gateway "${config.gateway}" not found.`);
  }

  // Check for duplicate target name
  if (gateway.targets.some(t => t.name === config.name)) {
    throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
  }

  // Check for duplicate tool names
  for (const toolDef of toolDefs) {
    for (const existingTarget of gateway.targets) {
      if ((existingTarget.toolDefinitions ?? []).some(t => t.name === toolDef.name)) {
        throw new Error(`Tool "${toolDef.name}" already exists in gateway "${gateway.name}".`);
      }
    }
  }

  // 'Other' language requires container config - not supported for gateway tools yet
  if (config.language === 'Other') {
    throw new Error('Language "Other" is not yet supported for gateway tools. Use Python or TypeScript.');
  }

  // Create a single target with all tool definitions
  const target: AgentCoreGatewayTarget = {
    name: config.name,
    targetType: config.host === 'AgentCoreRuntime' ? 'mcpServer' : 'lambda',
    toolDefinitions: toolDefs,
    compute:
      config.host === 'Lambda'
        ? {
            host: 'Lambda',
            implementation: {
              path: config.sourcePath,
              language: config.language,
              handler: DEFAULT_HANDLER,
            },
            ...(config.language === 'Python'
              ? { pythonVersion: DEFAULT_PYTHON_VERSION }
              : { nodeVersion: DEFAULT_NODE_VERSION }),
          }
        : {
            host: 'AgentCoreRuntime',
            implementation: {
              path: config.sourcePath,
              language: 'Python',
              handler: 'server.py:main',
            },
            runtime: {
              artifact: 'CodeZip',
              pythonVersion: DEFAULT_PYTHON_VERSION,
              name: config.name,
              entrypoint: 'server.py:main' as FilePath,
              codeLocation: config.sourcePath as DirectoryPath,
              networkMode: 'PUBLIC',
            },
          },
    ...(config.outboundAuth && { outboundAuth: config.outboundAuth }),
  };

  gateway.targets.push(target);

  // Write mcp.json for gateway case
  await configIO.writeMcpSpec(mcpSpec);

  // Update mcp-defs.json with all tool definitions
  const mcpDefsPath = resolveMcpDefsPath();
  try {
    const mcpDefs = await readMcpDefs(mcpDefsPath);
    for (const toolDef of toolDefs) {
      if (mcpDefs.tools[toolDef.name]) {
        throw new Error(`Tool definition "${toolDef.name}" already exists in mcp-defs.json.`);
      }
      mcpDefs.tools[toolDef.name] = toolDef;
    }
    await writeMcpDefs(mcpDefsPath, mcpDefs);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`MCP saved, but failed to update mcp-defs.json: ${message}`);
  }

  // Render gateway target project template
  // Resolve absolute path from project root
  const configRoot = requireConfigRoot();
  const projectRoot = dirname(configRoot);
  const absoluteSourcePath = join(projectRoot, config.sourcePath);
  await renderGatewayTargetTemplate(config.name, absoluteSourcePath, config.language, config.host);

  return { mcpDefsPath, toolName: config.name, projectPath: config.sourcePath };
}
