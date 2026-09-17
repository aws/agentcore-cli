import {
  APP_DIR,
  ConfigIO,
  ConflictError,
  NoProjectError,
  ResourceNotFoundError,
  ValidationError,
  findConfigRoot,
  serializeResult,
  setEnvVar,
  toError,
} from '../../lib';
import type { Result } from '../../lib/result';
import type {
  AgentEnvSpec,
  BuildType,
  CapacityProviderConfiguration,
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
  DEFAULT_ENTRYPOINT_BY_LANGUAGE,
  DEFAULT_RUNTIME_BY_LANGUAGE,
  LIFECYCLE_TIMEOUT_MAX,
  LIFECYCLE_TIMEOUT_MIN,
  isCapacityProviderArn,
} from '../../schema';
import { getCredentialProvider } from '../aws/account';
import type { AddAgentOptions as CLIAddAgentOptions } from '../commands/add/types';
import { validateAddAgentOptions } from '../commands/add/validate';
import {
  buildFilesystemConfigurations,
  validateAccessPointMounts,
  validateCapacityProviderVolumeMounts,
  validateEfsAccessPointArn,
  validateFilesystemMountsConfiguration,
  validateS3FilesAccessPointArn,
  zipAccessPointPairs,
  zipCapacityProviderVolumePairs,
} from '../commands/shared/filesystem-utils';
import { parseAndNormalizeHeaders } from '../commands/shared/header-utils';
import type { VpcOptions } from '../commands/shared/vpc-utils';
import { VPC_ENDPOINT_WARNING, parseCommaSeparatedList } from '../commands/shared/vpc-utils';
import { getErrorMessage } from '../errors';
import { createConfigBundleForAgent } from '../operations/agent/config-bundle-defaults';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../operations/agent/generate';
import { executeImportAgent } from '../operations/agent/import';
import { setupPythonProject } from '../operations/python';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import {
  AgentFramework,
  AgentLanguage,
  AgentProtocol,
  AgentSource,
  AuthorizerType,
  MemoryType,
  ModelProvider as ModelProviderEnum,
  NetworkMode as NetworkModeEnum,
  BuildType as TelemetryBuildType,
  standardize,
} from '../telemetry/schemas/common-shapes.js';
import { createRenderer } from '../templates';
import { requireTTY } from '../tui/guards/tty';
import type { AddFlowExitSummary } from '../tui/screens/add/AddFlow';
import type { GenerateConfig, MemoryOption } from '../tui/screens/generate/types';
import { BasePrimitive } from './BasePrimitive';
import { CredentialPrimitive } from './CredentialPrimitive';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from './auth-utils';
import { computeDefaultCredentialEnvVarName } from './credential-utils';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import { DescribeSubnetsCommand, EC2Client } from '@aws-sdk/client-ec2';
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
  sessionStorageMountPath?: string;
  efsAccessPointArns?: string[];
  efsMountPaths?: string[];
  s3AccessPointArns?: string[];
  s3MountPaths?: string[];
  /** Attach the runtime to a capacity provider — an in-project sibling name or an external CP ARN. */
  capacityProvider?: string;
  /** CP volume names to mount (paired by position with cpVolumeMountPaths). */
  cpVolumeNames?: string[];
  /** CP volume mount paths (paired by position with cpVolumeNames). */
  cpVolumeMountPaths?: string[];
  withConfigBundle?: boolean;
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

  /**
   * Build the capacityProviderConfiguration block from the flat `--capacity-provider <name-or-arn>`
   * value. An `arn:` prefix is treated as an external CP (by ARN); anything else is an in-project
   * sibling (by name). Returns undefined when the flag was not provided.
   */
  private buildCapacityProviderConfiguration(value?: string): CapacityProviderConfiguration | undefined {
    if (!value) return undefined;
    return isCapacityProviderArn(value) ? { capacityProviderArn: value } : { capacityProviderName: value };
  }

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
        return { success: false, error: new NoProjectError() };
      }

      const configIO = new ConfigIO({ baseDir: configBaseDir });

      if (!configIO.configExists('project')) {
        return { success: false, error: new NoProjectError() };
      }

      const project = await configIO.readProjectSpec();
      const existingAgent = project.runtimes.find(agent => agent.name === options.name);
      if (existingAgent) {
        return {
          success: false,
          error: new ConflictError(
            `Agent "${options.name}" already exists. To update its configuration, edit agentcore/agentcore.json directly.`
          ),
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
      return { success: false, error: toError(err) };
    }
  }

  async remove(agentName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const agentIndex = project.runtimes.findIndex(a => a.name === agentName);
      if (agentIndex === -1) {
        return { success: false, error: new ResourceNotFoundError(`Agent "${agentName}" not found.`) };
      }

      // Remove agent (credentials preserved for potential reuse)
      project.runtimes.splice(agentIndex, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
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
      .option(
        '--framework <fw>',
        'Framework: Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents, VercelAI [non-interactive]'
      )
      .option('--model-provider <provider>', 'Model provider: Bedrock, Anthropic, OpenAI, Gemini [non-interactive]')
      .option('--api-key <key>', 'API key for non-Bedrock providers [non-interactive]')
      .option('--memory <mem>', 'Memory: none, shortTerm, longAndShortTerm (create path only) [non-interactive]')
      .option('--protocol <protocol>', 'Protocol: HTTP, MCP, A2A, AGUI (default: HTTP) [non-interactive]')
      .option('--code-location <path>', 'Path to existing code (BYO path only) [non-interactive]')
      .option('--entrypoint <file>', 'Entry file relative to code-location (BYO, default: main.py) [non-interactive]')
      .option('--agent-id <id>', 'Bedrock Agent ID (import path only) [non-interactive]')
      .option('--agent-alias-id <id>', 'Bedrock Agent Alias ID (import path only) [non-interactive]')
      .option('--region <region>', 'AWS region for Bedrock Agent (import path only) [non-interactive]')
      .option('--network-mode <mode>', 'Network mode (PUBLIC, VPC) [non-interactive]')
      .option('--subnets <ids>', 'Comma-separated subnet IDs (required for VPC mode) [non-interactive]')
      .option('--security-groups <ids>', 'Comma-separated security group IDs (required for VPC mode) [non-interactive]')
      .option('--vpc-id <id>', 'VPC ID (required for Container builds with VPC mode) [non-interactive]')
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
        'Comma-separated list of header names to allow. X-prefixed names (e.g. Authorization, X-Api-Key, X-Custom-Signature) pass through unchanged; bare names without X- prefix are auto-prefixed with X-Amzn-Bedrock-AgentCore-Runtime-Custom- for backward compatibility. [non-interactive]'
      )
      .option(
        '--idle-timeout <seconds>',
        `Idle session timeout in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}) [non-interactive]`
      )
      .option(
        '--max-lifetime <seconds>',
        `Max instance lifetime in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}) [non-interactive]`
      )
      .option(
        '--session-storage-mount-path <path>',
        'Absolute mount path for session filesystem storage (e.g. /mnt/session-storage) [non-interactive]'
      )
      .option(
        '--efs-access-point-arn <arn>',
        'EFS access point ARN (repeatable, paired with --efs-mount-path) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option(
        '--efs-mount-path <path>',
        'EFS mount path (e.g. /mnt/tools, paired with --efs-access-point-arn) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option(
        '--s3-access-point-arn <arn>',
        'S3 Files access point ARN (repeatable, paired with --s3-mount-path) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option(
        '--s3-mount-path <path>',
        'S3 Files mount path (e.g. /mnt/datasets, paired with --s3-access-point-arn) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option(
        '--capacity-provider <name-or-arn>',
        'Attach to a capacity provider — an in-project capacity-provider name or an external CP ARN [non-interactive]'
      )
      .option(
        '--cp-volume-name <name>',
        'Capacity provider volume name to mount (repeatable, paired with --cp-volume-mount-path) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option(
        '--cp-volume-mount-path <path>',
        'Capacity provider volume mount path (e.g. /mnt/models, paired with --cp-volume-name) [non-interactive]',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[]
      )
      .option('--with-config-bundle', 'Create a config bundle wired into the agent template [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async options => {
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }

        const cliOptions = options as CLIAddAgentOptions;

        // Any flag triggers non-interactive CLI mode
        if (cliOptions.name || cliOptions.framework || cliOptions.json) {
          await runCliCommand('add.agent', !!cliOptions.json, async () => {
            const validation = validateAddAgentOptions(cliOptions);
            if (!validation.valid) {
              throw new ValidationError(validation.error!);
            }

            const efsArns = cliOptions.efsAccessPointArn ?? [];
            const efsPaths = cliOptions.efsMountPath ?? [];
            const s3Arns = cliOptions.s3AccessPointArn ?? [];
            const s3Paths = cliOptions.s3MountPath ?? [];

            const efsPairsResult = zipAccessPointPairs(efsArns, efsPaths, 'EFS');
            if (!efsPairsResult.success) throw new Error(efsPairsResult.error);

            const s3PairsResult = zipAccessPointPairs(s3Arns, s3Paths, 'S3 Files');
            if (!s3PairsResult.success) throw new Error(s3PairsResult.error);

            const efsValidation = validateAccessPointMounts(efsPairsResult.mounts, validateEfsAccessPointArn);
            if (!efsValidation.success) throw new Error(efsValidation.error);

            const s3Validation = validateAccessPointMounts(s3PairsResult.mounts, validateS3FilesAccessPointArn);
            if (!s3Validation.success) throw new Error(s3Validation.error);

            const cpVolNames = cliOptions.cpVolumeName ?? [];
            const cpVolPaths = cliOptions.cpVolumeMountPath ?? [];
            const cpVolPairsResult = zipCapacityProviderVolumePairs(cpVolNames, cpVolPaths);
            if (!cpVolPairsResult.success) throw new Error(cpVolPairsResult.error);
            const cpVolValidation = validateCapacityProviderVolumeMounts(cpVolPairsResult.mounts);
            if (!cpVolValidation.success) throw new Error(cpVolValidation.error);
            if (cpVolPairsResult.mounts.length > 0 && !cliOptions.capacityProvider) {
              throw new Error(
                'Capacity provider volume mounts (--cp-volume-name / --cp-volume-mount-path) require attaching the runtime to a capacity provider (--capacity-provider <name-or-arn>).'
              );
            }
            // A capacity provider supplies its own network topology, so --network-mode is not
            // settable alongside it (neither PUBLIC nor VPC).
            if (cliOptions.capacityProvider && cliOptions.networkMode !== undefined) {
              throw new Error(
                '--network-mode cannot be set when attaching a capacity provider (--capacity-provider) — the capacity provider supplies the network topology. Remove --network-mode.'
              );
            }

            const hasByoFs = efsArns.length > 0 || s3Arns.length > 0;
            if (hasByoFs && cliOptions.networkMode !== 'VPC') {
              throw new Error(
                'EFS and S3 Files filesystem mounts require VPC network mode. Add --network-mode VPC --subnets <ids> --security-groups <ids>.'
              );
            }

            // Async filesystem validation (Level 1–3): skip when no BYO FS mounts
            if (hasByoFs) {
              const agentSubnetIds = parseCommaSeparatedList(cliOptions.subnets);
              const agentSgIds = parseCommaSeparatedList(cliOptions.securityGroups);
              const configRoot = findConfigRoot();
              const targets = configRoot
                ? await new ConfigIO({ baseDir: configRoot }).resolveAWSDeploymentTargets()
                : [];
              const awsRegion =
                targets[0]?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

              // Resolve agent VPC ID from first subnet (non-fatal: skip Level 2 if unavailable)
              let agentVpcId: string | undefined;
              if (agentSubnetIds && agentSubnetIds.length > 0) {
                try {
                  const ec2 = new EC2Client({ region: awsRegion, credentials: getCredentialProvider() });
                  const subnetResp = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: agentSubnetIds }));
                  agentVpcId = subnetResp.Subnets?.[0]?.VpcId;
                } catch {
                  // skip
                }
              }

              const fsValidation = await validateFilesystemMountsConfiguration({
                efsMounts: efsPairsResult.mounts,
                s3FilesMounts: s3PairsResult.mounts,
                agentVpcId,
                agentSubnetIds: agentSubnetIds ?? [],
                agentSecurityGroupIds: agentSgIds ?? [],
                region: awsRegion,
              });
              if (!fsValidation.success) throw new Error(fsValidation.error);
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
              vpcId: cliOptions.vpcId,
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
              sessionStorageMountPath: cliOptions.sessionStorageMountPath,
              efsAccessPointArns: efsArns,
              efsMountPaths: efsPaths,
              s3AccessPointArns: s3Arns,
              s3MountPaths: s3Paths,
              capacityProvider: cliOptions.capacityProvider,
              cpVolumeNames: cliOptions.cpVolumeName ?? [],
              cpVolumeMountPaths: cliOptions.cpVolumeMountPath ?? [],
              withConfigBundle: cliOptions.withConfigBundle,
            });

            if (!result.success) {
              throw result.error;
            }

            if (cliOptions.json) {
              console.log(JSON.stringify(serializeResult(result)));
            } else {
              console.log(`Added agent '${result.agentName}'`);
              if (result.agentPath) {
                console.log(`Agent code: ${result.agentPath}`);
              }
              if (cliOptions.networkMode === 'VPC') {
                console.log(`\x1b[33mNote: ${VPC_ENDPOINT_WARNING}\x1b[0m`);
              }
            }

            return {
              agent_language: standardize(AgentLanguage, cliOptions.language),
              agent_framework: standardize(AgentFramework, cliOptions.framework),
              model_provider: standardize(ModelProviderEnum, cliOptions.modelProvider),
              agent_source: standardize(AgentSource, cliOptions.type ?? 'create'),
              build_type: standardize(TelemetryBuildType, cliOptions.build ?? 'CodeZip'),
              agent_protocol: standardize(AgentProtocol, cliOptions.protocol ?? 'HTTP'),
              network_mode: standardize(NetworkModeEnum, cliOptions.networkMode ?? 'PUBLIC'),
              authorizer_type: standardize(AuthorizerType, cliOptions.authorizerType ?? 'NONE'),
              memory_type: standardize(MemoryType, cliOptions.memory ?? 'none'),
              efs_mount_count: efsArns.length,
              s3_mount_count: s3Arns.length,
              has_capacity_provider: !!cliOptions.capacityProvider,
              capacity_provider_by_arn:
                !!cliOptions.capacityProvider && isCapacityProviderArn(cliOptions.capacityProvider),
              cp_volume_mount_count: cpVolNames.length,
            };
          });
        } else {
          try {
            // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
            requireTTY();
            const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/add/AddFlow'),
            ]);
            const { clear, unmount } = render(
              React.createElement(AddFlow, {
                isInteractive: false,
                initialResource: 'agent',
                onExit: (summary?: AddFlowExitSummary) => {
                  clear();
                  unmount();
                  // The TUI success screen is torn down by clear(); print a plain-text
                  // confirmation so the user is not left at an empty prompt (#671).
                  if (summary) {
                    console.log(`✓ Created agent: ${summary.agentName}`);
                    if (summary.projectPath) {
                      console.log(`Agent code: ${summary.projectPath}`);
                    }
                    console.log('Next: run `agentcore dev` to test locally, or `agentcore deploy` to deploy.');
                  }
                  process.exit(0);
                },
              })
            );
          } catch (error) {
            console.error(getErrorMessage(error));
            process.exit(1);
          }
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
      vpcId: options.vpcId,
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
      sessionStorageMountPath: options.sessionStorageMountPath,
      efsAccessPoints: (options.efsAccessPointArns ?? []).map((arn, i) => ({
        accessPointArn: arn,
        mountPath: (options.efsMountPaths ?? [])[i] ?? '',
      })),
      s3AccessPoints: (options.s3AccessPointArns ?? []).map((arn, i) => ({
        accessPointArn: arn,
        mountPath: (options.s3MountPaths ?? [])[i] ?? '',
      })),
      capacityProviderConfiguration: this.buildCapacityProviderConfiguration(options.capacityProvider),
      capacityProviderVolumes: (options.cpVolumeNames ?? []).map((volumeName, i) => ({
        volumeName,
        mountPath: (options.cpVolumeMountPaths ?? [])[i] ?? '',
      })),
      withConfigBundle: options.withConfigBundle,
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

    if (options.withConfigBundle) {
      await createConfigBundleForAgent(options.name, configBaseDir);
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
      sessionStorageMountPath: options.sessionStorageMountPath,
      efsAccessPoints: (options.efsAccessPointArns ?? []).map((arn, i) => ({
        accessPointArn: arn,
        mountPath: (options.efsMountPaths ?? [])[i] ?? '',
      })),
      s3AccessPoints: (options.s3AccessPointArns ?? []).map((arn, i) => ({
        accessPointArn: arn,
        mountPath: (options.s3MountPaths ?? [])[i] ?? '',
      })),
      capacityProviderConfiguration: this.buildCapacityProviderConfiguration(options.capacityProvider),
      capacityProviderVolumes: (options.cpVolumeNames ?? []).map((volumeName, i) => ({
        volumeName,
        mountPath: (options.cpVolumeMountPaths ?? [])[i] ?? '',
      })),
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
    const capacityProviderConfiguration = this.buildCapacityProviderConfiguration(options.capacityProvider);
    // A capacity provider supplies its own network topology, so a CP-attached runtime carries no
    // networkMode/networkConfig at all (they are mutually exclusive — see the AgentEnvSpec refine).
    const networkMode = capacityProviderConfiguration
      ? undefined
      : ((options.networkMode as NetworkMode | undefined) ?? 'PUBLIC');
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
    const defaultLanguage = options.language === 'TypeScript' ? 'TypeScript' : 'Python';

    const agent: AgentEnvSpec = {
      name: options.name,
      build: options.buildType,
      entrypoint: (options.entrypoint ?? DEFAULT_ENTRYPOINT_BY_LANGUAGE[defaultLanguage]) as FilePath,
      codeLocation: codeLocation as DirectoryPath,
      runtimeVersion: DEFAULT_RUNTIME_BY_LANGUAGE[defaultLanguage],
      protocol,
      ...(networkMode !== undefined && { networkMode }),
      ...(networkMode === 'VPC' &&
        subnets &&
        securityGroups && {
          networkConfig: {
            subnets,
            securityGroups,
            ...(options.vpcId && { vpcId: options.vpcId }),
          },
        }),
      // MCP uses mcp.run() which is incompatible with the opentelemetry-instrument wrapper
      ...(protocol === 'MCP' && { instrumentation: { enableOtel: false } }),
      ...(options.requestHeaderAllowlist?.length && {
        requestHeaderAllowlist: options.requestHeaderAllowlist,
      }),
      ...(authorizerType && { authorizerType }),
      ...(authorizerConfiguration && { authorizerConfiguration }),
      ...(lifecycleConfiguration && { lifecycleConfiguration }),
      ...(capacityProviderConfiguration && { capacityProviderConfiguration }),
      ...buildFilesystemConfigurations(
        options.sessionStorageMountPath,
        (options.efsAccessPointArns ?? []).map((arn, i) => ({
          accessPointArn: arn,
          mountPath: (options.efsMountPaths ?? [])[i] ?? '',
        })),
        (options.s3AccessPointArns ?? []).map((arn, i) => ({
          accessPointArn: arn,
          mountPath: (options.s3MountPaths ?? [])[i] ?? '',
        })),
        (options.cpVolumeNames ?? []).map((volumeName, i) => ({
          volumeName,
          mountPath: (options.cpVolumeMountPaths ?? [])[i] ?? '',
        }))
      ),
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
