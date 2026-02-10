import { APP_DIR, ConfigIO, MCP_APP_SUBDIR, NoProjectError, findConfigRoot, setEnvVar } from '../../../lib';
import type {
  AgentEnvSpec,
  DirectoryPath,
  FilePath,
  GatewayAuthorizerType,
  MemoryStrategyType,
  ModelProvider,
  SDKFramework,
  TargetLanguage,
} from '../../../schema';
import { getErrorMessage } from '../../errors';
import { setupPythonProject } from '../../operations';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../../operations/agent/generate';
import {
  computeDefaultCredentialEnvVarName,
  createCredential,
  resolveCredentialStrategy,
} from '../../operations/identity/create-identity';
import { createGatewayFromWizard, createToolFromWizard } from '../../operations/mcp/create-mcp';
import { createMemory } from '../../operations/memory/create-memory';
import { createRenderer } from '../../templates';
import type { MemoryOption } from '../../tui/screens/generate/types';
import type { AddGatewayConfig, AddMcpToolConfig } from '../../tui/screens/mcp/types';
import { DEFAULT_EVENT_EXPIRY } from '../../tui/screens/memory/types';
import type { AddAgentResult, AddGatewayResult, AddIdentityResult, AddMcpToolResult, AddMemoryResult } from './types';
import { dirname, join } from 'path';

// Validated option interfaces
export interface ValidatedAddAgentOptions {
  name: string;
  type: 'create' | 'byo';
  language: TargetLanguage;
  framework: SDKFramework;
  modelProvider: ModelProvider;
  apiKey?: string;
  memory?: MemoryOption;
  codeLocation?: string;
  entrypoint?: string;
}

export interface ValidatedAddGatewayOptions {
  name: string;
  description?: string;
  authorizerType: GatewayAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  agents?: string;
}

export interface ValidatedAddMcpToolOptions {
  name: string;
  description?: string;
  language: 'Python' | 'TypeScript' | 'Other';
  exposure: 'mcp-runtime' | 'behind-gateway';
  agents?: string;
  gateway?: string;
  host?: 'Lambda' | 'AgentCoreRuntime';
}

export interface ValidatedAddMemoryOptions {
  name: string;
  strategies?: string;
  expiry?: number;
}

export interface ValidatedAddIdentityOptions {
  name: string;
  apiKey: string;
}

// Agent handlers
export async function handleAddAgent(options: ValidatedAddAgentOptions): Promise<AddAgentResult> {
  try {
    const configBaseDir = findConfigRoot();
    if (!configBaseDir) {
      return { success: false, error: new NoProjectError().message };
    }

    const configIO = new ConfigIO({ baseDir: configBaseDir });

    if (!configIO.configExists('project')) {
      return { success: false, error: new NoProjectError().message };
    }

    const project = await configIO.readProjectSpec();
    const existingAgent = project.agents.find(agent => agent.name === options.name);
    if (existingAgent) {
      return { success: false, error: `Agent "${options.name}" already exists in this project.` };
    }

    if (options.type === 'byo') {
      return await handleByoPath(options, configIO, configBaseDir);
    } else {
      return await handleCreatePath(options, configBaseDir);
    }
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

async function handleCreatePath(options: ValidatedAddAgentOptions, configBaseDir: string): Promise<AddAgentResult> {
  const projectRoot = dirname(configBaseDir);
  const configIO = new ConfigIO({ baseDir: configBaseDir });
  const project = await configIO.readProjectSpec();

  const generateConfig = {
    projectName: options.name,
    sdk: options.framework,
    modelProvider: options.modelProvider,
    memory: options.memory!,
    language: options.language,
  };

  const agentPath = join(projectRoot, APP_DIR, options.name);

  // Resolve credential strategy FIRST to determine correct credential name
  let identityProviders: ReturnType<typeof mapModelProviderToIdentityProviders> = [];
  let strategy: Awaited<ReturnType<typeof resolveCredentialStrategy>> | undefined;

  if (options.modelProvider !== 'Bedrock') {
    strategy = await resolveCredentialStrategy(
      project.name,
      options.name,
      options.modelProvider,
      options.apiKey,
      configBaseDir,
      project.credentials
    );

    // Build identity providers with the correct credential name from strategy
    identityProviders = [
      {
        name: strategy.credentialName,
        envVarName: strategy.envVarName,
      },
    ];
  }

  // Render templates with correct identity provider
  const renderConfig = mapGenerateConfigToRenderConfig(generateConfig, identityProviders);
  const renderer = createRenderer(renderConfig);
  await renderer.render({ outputDir: projectRoot });

  // Write agent to project config
  if (strategy) {
    await writeAgentToProject(generateConfig, { configBaseDir, credentialStrategy: strategy });

    // Always write env var (empty if skipped) so users can easily find and fill it in
    // Use project-scoped name if strategy returned empty (no API key case)
    const envVarName =
      strategy.envVarName || computeDefaultCredentialEnvVarName(`${project.name}${options.modelProvider}`);
    await setEnvVar(envVarName, options.apiKey ?? '', configBaseDir);
  } else {
    await writeAgentToProject(generateConfig, { configBaseDir });
  }

  if (options.language === 'Python') {
    await setupPythonProject({ projectDir: agentPath });
  }

  return { success: true, agentName: options.name, agentPath };
}

async function handleByoPath(
  options: ValidatedAddAgentOptions,
  configIO: ConfigIO,
  configBaseDir: string
): Promise<AddAgentResult> {
  const codeLocation = options.codeLocation!.endsWith('/') ? options.codeLocation! : `${options.codeLocation!}/`;

  const project = await configIO.readProjectSpec();

  const agent: AgentEnvSpec = {
    type: 'AgentCoreRuntime',
    name: options.name,
    build: 'CodeZip',
    entrypoint: (options.entrypoint ?? 'main.py') as FilePath,
    codeLocation: codeLocation as DirectoryPath,
    runtimeVersion: 'PYTHON_3_12',
    networkMode: 'PUBLIC',
  };

  project.agents.push(agent);

  // Handle credential creation with smart reuse detection
  if (options.modelProvider !== 'Bedrock') {
    const strategy = await resolveCredentialStrategy(
      project.name,
      options.name,
      options.modelProvider,
      options.apiKey,
      configBaseDir,
      project.credentials
    );

    if (!strategy.reuse) {
      const credentials = mapModelProviderToCredentials(options.modelProvider, project.name);
      if (credentials.length > 0) {
        credentials[0]!.name = strategy.credentialName;
        project.credentials.push(...credentials);
      }
    }

    // Always write env var (empty if skipped) so users can easily find and fill it in
    // Use project-scoped name if strategy returned empty (no API key case)
    const envVarName =
      strategy.envVarName || computeDefaultCredentialEnvVarName(`${project.name}${options.modelProvider}`);
    await setEnvVar(envVarName, options.apiKey ?? '', configBaseDir);
  }

  await configIO.writeProjectSpec(project);

  return { success: true, agentName: options.name };
}

// Gateway handler
function buildGatewayConfig(options: ValidatedAddGatewayOptions): AddGatewayConfig {
  const agents = options.agents
    ? options.agents
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  const config: AddGatewayConfig = {
    name: options.name,
    description: options.description ?? `Gateway for ${options.name}`,
    agents,
    authorizerType: options.authorizerType,
    jwtConfig: undefined,
  };

  if (options.authorizerType === 'CUSTOM_JWT' && options.discoveryUrl) {
    config.jwtConfig = {
      discoveryUrl: options.discoveryUrl,
      allowedAudience: options.allowedAudience
        ? options.allowedAudience
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [],
      allowedClients: options
        .allowedClients!.split(',')
        .map(s => s.trim())
        .filter(Boolean),
    };
  }

  return config;
}

export async function handleAddGateway(options: ValidatedAddGatewayOptions): Promise<AddGatewayResult> {
  try {
    const config = buildGatewayConfig(options);
    const result = await createGatewayFromWizard(config);
    return { success: true, gatewayName: result.name };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// MCP Tool handler
function buildMcpToolConfig(options: ValidatedAddMcpToolOptions): AddMcpToolConfig {
  const sourcePath = `${APP_DIR}/${MCP_APP_SUBDIR}/${options.name}`;

  const description = options.description ?? `Tool for ${options.name}`;
  return {
    name: options.name,
    description,
    sourcePath,
    language: options.language,
    exposure: options.exposure,
    host: options.exposure === 'mcp-runtime' ? 'AgentCoreRuntime' : options.host!,
    toolDefinition: {
      name: options.name,
      description,
      inputSchema: { type: 'object' },
    },
    selectedAgents:
      options.exposure === 'mcp-runtime'
        ? options
            .agents!.split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [],
    gateway: options.exposure === 'behind-gateway' ? options.gateway : undefined,
  };
}

export async function handleAddMcpTool(options: ValidatedAddMcpToolOptions): Promise<AddMcpToolResult> {
  try {
    const config = buildMcpToolConfig(options);
    const result = await createToolFromWizard(config);
    return { success: true, toolName: result.toolName, sourcePath: result.projectPath };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// Memory handler (v2: top-level resource, no owner/user)
export async function handleAddMemory(options: ValidatedAddMemoryOptions): Promise<AddMemoryResult> {
  try {
    const strategies = options.strategies
      ? options.strategies
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(type => ({ type: type as MemoryStrategyType }))
      : [];

    const result = await createMemory({
      name: options.name,
      eventExpiryDuration: options.expiry ?? DEFAULT_EVENT_EXPIRY,
      strategies,
    });

    return { success: true, memoryName: result.name };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// Identity handler (v2: top-level credential resource, no owner/user)
export async function handleAddIdentity(options: ValidatedAddIdentityOptions): Promise<AddIdentityResult> {
  try {
    const result = await createCredential({
      name: options.name,
      apiKey: options.apiKey,
    });

    return { success: true, credentialName: result.name };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
