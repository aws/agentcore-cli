import { APP_DIR, ConfigIO, NoProjectError, findConfigRoot, setEnvVar } from '../../lib';
import type {
  AgentEnvSpec,
  BuildType,
  CustomClaimValidation,
  DirectoryPath,
  FilePath,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  RuntimeAuthorizerType,
  SDKFramework,
  TargetLanguage,
} from '../../schema';
import {
  AgentEnvSpecSchema,
  CREDENTIAL_PROVIDERS,
  DEFAULT_PYTHON_VERSION,
  LIFECYCLE_TIMEOUT_MAX,
  LIFECYCLE_TIMEOUT_MIN,
} from '../../schema';
import type { AddAgentOptions as CLIAddAgentOptions } from '../commands/add/types';
import { validateAddAgentOptions } from '../commands/add/validate';
import { parseAndNormalizeHeaders } from '../commands/shared/header-utils';
import type { VpcOptions } from '../commands/shared/vpc-utils';
import { VPC_ENDPOINT_WARNING, parseCommaSeparatedList } from '../commands/shared/vpc-utils';
import { getErrorMessage } from '../errors';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../operations/agent/generate';
import { executeImportAgent } from '../operations/agent/import';
import { setupPythonProject } from '../operations/python';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { createRenderer } from '../templates';
import type { GenerateConfig, MemoryOption } from '../tui/screens/generate/types';
import { BasePrimitive } from './BasePrimitive';
import { CredentialPrimitive } from './CredentialPrimitive';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from './auth-utils';
import { computeDefaultCredentialEnvVarName } from './credential-utils';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Options for adding an agent resource.
 */
export interface AddAgentOptions extends VpcOptions {
  name: string;
  type: 'create' | 'byo' | 'import';
  buildType: BuildType;
  language: TargetLanguage;
  framework: SDKFramework;
  modelProvider: ModelProvider;
  apiKey?: string;
  memory?: MemoryOption;
  protocol?: ProtocolMode;
  requestHeaderAllowlist?: string[];
  codeLocation?: string;
  entrypoint?: string;
  bedrockAgentId?: string;
  bedrockAliasId?: string;
  bedrockRegion?: string;
  authorizerType?: RuntimeAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  customClaims?: CustomClaimValidation[];
  clientId?: string;
  clientSecret?: string;
  idleTimeout?: number;
  maxLifetime?: number;
}

/**
 * AgentPrimitive handles all agent add/remove operations.
 * Absorbs logic from actions.ts handleAddAgent/handleCreatePath/handleByoPath and remove-agent.ts.
 */
export class AgentPrimitive extends BasePrimitive<AddAgentOptions, RemovableResource> {
  readonly kind = 'agent';
  readonly label = 'Agent';
  override readonly article = 'an';
  readonly primitiveSchema = AgentEnvSpecSchema;

  /** Local instance to avoid circular dependency with registry. */
  private readonly credentialPrimitive = new CredentialPrimitive();

  /** Build lifecycleConfiguration block from flat options - only if at least one value is set. */
  private buildLifecycleConfig(options: { idleTimeout?: number; maxLifetime?: number }) {
    if (options.idleTimeout === undefined && options.maxLifetime === undefined) return undefined;
    return {
      ...(options.idleTimeout !== undefined && { idleRuntimeSessionTimeout: options.idleTimeout }),
      ...(options.maxLifetime !== undefined && { maxLifetime: options.maxLifetime }),
    };
  }

  async add(options: AddAgentOptions): Promise<AddResult<{ agentName: string; agentPath?: string }>> {
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
      const existingAgent = project.runtimes.find(agent => agent.name === options.name);
      if (existingAgent) {
        return {
          success: false,
          error: `Agent "${options.name}" already exists. To update its configuration, edit agentcore/agentcore.json directly.`,
        };
      }

      if (options.type === 'import') {
        return await this.handleImportPath(options, configBaseDir);
      } else if (options.type === 'byo') {
        return await this.handleByoPath(options, configIO, configBaseDir);
      } else {
        return await this.handleCreatePath(options, configBaseDir);
      }
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(agentName: string): Promise<RemovalResult> {
    try {
      const project = await this.readProjectSpec();

      const agentIndex = project.runtimes.findIndex(a => a.name === agentName);
      if (agentIndex === -1) {
        return { success: false, error: `Agent "${agentName}" not found.` };
      }

      // Remove agent (credentials preserved for potential reuse)
      project.runtimes.splice(agentIndex, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  async previewRemove(agentName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const agent = project.runtimes.find(a => a.name === agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not found.`);
    }

    const summary: string[] = [`Removing agent: ${agentName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      runtimes: project.runtimes.filter(a => a.name !== agentName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      const project = await this.readProjectSpec();
      return project.runtimes.map(a => ({ name: a.name }));
    } catch {
      return [];
    }
  }

  /**
   * Find agent-scoped credentials for a given agent.
   * Pattern: {projectName}{agentName}{provider}
   */
  static getAgentScopedCredentials(
    projectName: string,
    agentName: string,
    credentials: { name: string }[]
  ): { name: string }[] {
    const prefix = `${projectName}${agentName}`;
    return credentials.filter(c => {
      if (!c.name.startsWith(prefix)) return false;
      const suffix = c.name.slice(prefix.length);
      return CREDENTIAL_PROVIDERS.includes(suffix as (typeof CREDENTIAL_PROVIDERS)[number]);
    });
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('agent')
      .description('Add an agent to the project')
      .option(
        '--name <name>',
        'Agent name (start with letter, alphanumeric + underscores, max 48 chars) [non-interactive]'
      )
      .option('--type <type>', 'Agent type: create, byo, or import [non-interactive]', 'create')
      .option('--build <type>', 'Build type: CodeZip or Container (default: CodeZip) [non-interactive]')
      .option('--language <lang>', 'Language: Python (create), or Python/TypeScript/Other (BYO) [non-interactive]')
      .option('--framework <fw>', 'Framework: Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents [non-interactive]')
      .option('--model-provider <provider>', 'Model provider: Bedrock, Anthropic, OpenAI, Gemini [non-interactive]')
      .option('--api-key <key>', 'API key for non-Bedrock providers [non-interactive]')
      .option('--memory <mem>', 'Memory: none, shortTerm, longAndShortTerm (create path only) [non-interactive]')
      .option('--protocol <protocol>', 'Protocol: HTTP, MCP, A2A (default: HTTP) [non-interactive]')
      .option('--code-location <path>', 'Path to existing code (BYO path only) [non-interactive]')
      .option('--entrypoint <file>', 'Entry file relative to code-location (BYO, default: main.py) [non-interactive]')
      .option('--agent-id <id>', 'Bedrock Agent ID (import path only) [non-interactive]')
      .option('--agent-alias-id <id>', 'Bedrock Agent Alias ID (import path only) [non-interactive]')
      .option('--region <region>', 'AWS region for Bedrock Agent (import path only) [non-interactive]')
      .option('--network-mode <mode>', 'Network mode (PUBLIC, VPC) [non-interactive]')
      .option('--subnets <ids>', 'Comma-separated subnet IDs (required for VPC mode) [non-interactive]')
      .option('--security-groups <ids>', 'Comma-separated security group IDs (required for VPC mode) [non-interactive]')
      .option('--authorizer-type <type>', 'Inbound auth: AWS_IAM or CUSTOM_JWT [non-interactive]')
      .option('--discovery-url <url>', 'OIDC discovery URL (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-audience <audience>', 'Comma-separated allowed audiences (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT) [non-interactive]')
      .option('--custom-claims <json>', 'Custom claim validations as JSON array (for CUSTOM_JWT) [non-interactive]')
      .option('--client-id <id>', 'OAuth client ID for agent bearer token [non-interactive]')
      .option('--client-secret <secret>', 'OAuth client secret [non-interactive]')
      .option(
        '--request-header-allowlist <headers>',
        'Comma-separated list of custom header names to allow (auto-prefixed with X-Amzn-Bedrock-AgentCore-Runtime-Custom-) [non-interactive]'
      )
      .option(
        '--idle-timeout <seconds>',
        `Idle session timeout in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}) [non-interactive]`
      )
      .option(
        '--max-lifetime <seconds>',
        `Max instance lifetime in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}) [non-interactive]`
      )
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async options => {
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }

        const cliOptions = options as CLIAddAgentOptions;

        // Any flag triggers non-interactive CLI mode
        if (cliOptions.name || cliOptions.framework || cliOptions.json) {
          const validation = validateAddAgentOptions(cliOptions);
          if (!validation.valid) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: validation.error }));
            } else {
              console.error(validation.error);
            }
            process.exit(1);
          }

          // Parse custom claims JSON if provided (already validated by validateAddAgentOptions)
          const customClaims = cliOptions.customClaims
            ? (JSON.parse(cliOptions.customClaims) as CustomClaimValidation[])
            : undefined;

          // Parse request header allowlist if provided
          const requestHeaderAllowlist = cliOptions.requestHeaderAllowlist
            ? parseAndNormalizeHeaders(cliOptions.requestHeaderAllowlist)
            : undefined;

          const result = await this.add({
            name: cliOptions.name!,
            type: cliOptions.type ?? 'create',
            buildType: (cliOptions.build as BuildType) ?? 'CodeZip',
            language: cliOptions.language!,
            framework: cliOptions.framework!,
            modelProvider: cliOptions.modelProvider!,
            apiKey: cliOptions.apiKey,
            memory: cliOptions.memory,
            protocol: cliOptions.protocol,
            networkMode: cliOptions.networkMode,
            subnets: cliOptions.subnets,
            securityGroups: cliOptions.securityGroups,
            requestHeaderAllowlist,
            codeLocation: cliOptions.codeLocation,
            entrypoint: cliOptions.entrypoint,
            bedrockAgentId: cliOptions.agentId,
            bedrockAliasId: cliOptions.agentAliasId,
            bedrockRegion: cliOptions.region,
            authorizerType: cliOptions.authorizerType,
            discoveryUrl: cliOptions.discoveryUrl,
            allowedAudience: cliOptions.allowedAudience,
            allowedClients: cliOptions.allowedClients,
            allowedScopes: cliOptions.allowedScopes,
            customClaims,
            clientId: cliOptions.clientId,
            clientSecret: cliOptions.clientSecret,
            idleTimeout: cliOptions.idleTimeout ? Number(cliOptions.idleTimeout) : undefined,
            maxLifetime: cliOptions.maxLifetime ? Number(cliOptions.maxLifetime) : undefined,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            console.log(`Added agent '${result.agentName}'`);
            if (result.agentPath) {
              console.log(`Agent code: ${result.agentPath}`);
            }
            if (cliOptions.networkMode === 'VPC') {
              console.log(`\x1b[33mNote: ${VPC_ENDPOINT_WARNING}\x1b[0m`);
            }
          } else {
            console.error(result.error);
          }

          process.exit(result.success ? 0 : 1);
        } else {
          // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
          const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
            import('ink'),
            import('react'),
            import('../tui/screens/add/AddFlow'),
          ]);
          const { clear, unmount } = render(
            React.createElement(AddFlow, {
              isInteractive: false,
              onExit: () => {
                clear();
                unmount();
                process.exit(0);
              },
            })
          );
        }
      });

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Handle "create" path: generate agent from template.
   */
  private async handleCreatePath(
    options: AddAgentOptions,
    configBaseDir: string
  ): Promise<AddResult<{ agentName: string; agentPath?: string }>> {
    const projectRoot = dirname(configBaseDir);
    const configIO = new ConfigIO({ baseDir: configBaseDir });
    const project = await configIO.readProjectSpec();

    const generateConfig: GenerateConfig = {
      projectName: options.name,
      buildType: options.buildType,
      sdk: options.framework,
      modelProvider: options.modelProvider,
      memory: options.memory!,
      language: options.language,
      protocol: options.protocol ?? 'HTTP',
      networkMode: options.networkMode as NetworkMode | undefined,
      subnets: parseCommaSeparatedList(options.subnets),
      securityGroups: parseCommaSeparatedList(options.securityGroups),
      authorizerType: options.authorizerType,
      ...(options.authorizerType === 'CUSTOM_JWT' &&
        options.discoveryUrl && {
          jwtConfig: {
            discoveryUrl: options.discoveryUrl,
            allowedAudience: options.allowedAudience
              ? options.allowedAudience
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            allowedClients: options.allowedClients
              ? options.allowedClients
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            allowedScopes: options.allowedScopes
              ? options.allowedScopes
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            customClaims: options.customClaims,
          },
        }),
      requestHeaderAllowlist: options.requestHeaderAllowlist,
      idleRuntimeSessionTimeout: options.idleTimeout,
      maxLifetime: options.maxLifetime,
    };

    const agentPath = join(projectRoot, APP_DIR, options.name);

    // Resolve credential strategy FIRST to determine correct credential name
    let identityProviders: ReturnType<typeof mapModelProviderToIdentityProviders> = [];
    let strategy: Awaited<ReturnType<CredentialPrimitive['resolveCredentialStrategy']>> | undefined;

    const isMcp = options.protocol === 'MCP';

    if (!isMcp && options.modelProvider !== 'Bedrock') {
      strategy = await this.credentialPrimitive.resolveCredentialStrategy(
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
    const renderConfig = await mapGenerateConfigToRenderConfig(generateConfig, identityProviders);
    const renderer = createRenderer(renderConfig);
    await renderer.render({ outputDir: projectRoot });

    // Write agent to project config
    if (strategy) {
      await writeAgentToProject(generateConfig, { configBaseDir, credentialStrategy: strategy });

      // Always write env var (empty if skipped) so users can easily find and fill it in
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

  /**
   * Handle "import" path: import from Bedrock Agents.
   */
  private async handleImportPath(
    options: AddAgentOptions,
    configBaseDir: string
  ): Promise<AddResult<{ agentName: string; agentPath?: string }>> {
    return executeImportAgent({
      name: options.name,
      framework: options.framework,
      memory: options.memory ?? 'none',
      bedrockRegion: options.bedrockRegion!,
      bedrockAgentId: options.bedrockAgentId!,
      bedrockAliasId: options.bedrockAliasId!,
      configBaseDir,
      idleTimeout: options.idleTimeout,
      maxLifetime: options.maxLifetime,
    });
  }

  /**
   * Handle "byo" path: bring your own code.
   */
  private async handleByoPath(
    options: AddAgentOptions,
    configIO: ConfigIO,
    configBaseDir: string
  ): Promise<AddResult<{ agentName: string; agentPath?: string }>> {
    const codeLocation = options.codeLocation!.endsWith('/') ? options.codeLocation! : `${options.codeLocation!}/`;

    // Create the agent code directory so users know where to put their code
    const projectRoot = dirname(configBaseDir);
    const codeDir = join(projectRoot, codeLocation.replace(/\/$/, ''));
    mkdirSync(codeDir, { recursive: true });

    const project = await configIO.readProjectSpec();

    const protocol = options.protocol ?? 'HTTP';
    const networkMode = (options.networkMode as NetworkMode | undefined) ?? 'PUBLIC';
    const subnets = parseCommaSeparatedList(options.subnets);
    const securityGroups = parseCommaSeparatedList(options.securityGroups);

    // Build authorizer configuration if CUSTOM_JWT
    const authorizerType = options.authorizerType;
    const authorizerConfiguration =
      authorizerType === 'CUSTOM_JWT' && options.discoveryUrl
        ? buildAuthorizerConfigFromJwtConfig({
            discoveryUrl: options.discoveryUrl,
            allowedAudience: options.allowedAudience
              ? options.allowedAudience
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            allowedClients: options.allowedClients
              ? options.allowedClients
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            allowedScopes: options.allowedScopes
              ? options.allowedScopes
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : undefined,
            customClaims: options.customClaims,
          })
        : undefined;

    const lifecycleConfiguration = this.buildLifecycleConfig(options);

    const agent: AgentEnvSpec = {
      name: options.name,
      build: options.buildType,
      entrypoint: (options.entrypoint ?? 'main.py') as FilePath,
      codeLocation: codeLocation as DirectoryPath,
      runtimeVersion: DEFAULT_PYTHON_VERSION,
      protocol,
      networkMode,
      ...(networkMode === 'VPC' &&
        subnets &&
        securityGroups && {
          networkConfig: { subnets, securityGroups },
        }),
      // MCP uses mcp.run() which is incompatible with the opentelemetry-instrument wrapper
      ...(protocol === 'MCP' && { instrumentation: { enableOtel: false } }),
      ...(options.requestHeaderAllowlist?.length && {
        requestHeaderAllowlist: options.requestHeaderAllowlist,
      }),
      ...(authorizerType && { authorizerType }),
      ...(authorizerConfiguration && { authorizerConfiguration }),
      ...(lifecycleConfiguration && { lifecycleConfiguration }),
    };

    project.runtimes.push(agent);

    // Handle credential creation with smart reuse detection (skip for MCP)
    if (options.protocol !== 'MCP' && options.modelProvider !== 'Bedrock') {
      const strategy = await this.credentialPrimitive.resolveCredentialStrategy(
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
      const envVarName =
        strategy.envVarName || computeDefaultCredentialEnvVarName(`${project.name}${options.modelProvider}`);
      await setEnvVar(envVarName, options.apiKey ?? '', configBaseDir);
    }

    await configIO.writeProjectSpec(project);

    // Auto-create OAuth credential for CUSTOM_JWT inbound auth
    if (authorizerType === 'CUSTOM_JWT' && options.clientId && options.clientSecret && options.discoveryUrl) {
      await createManagedOAuthCredential(
        options.name,
        { discoveryUrl: options.discoveryUrl, clientId: options.clientId, clientSecret: options.clientSecret },
        spec => configIO.writeProjectSpec(spec),
        () => configIO.readProjectSpec()
      );
    }

    return { success: true, agentName: options.name };
  }
}
