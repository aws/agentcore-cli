import {
  APP_DIR,
  MCP_APP_SUBDIR,
  ResourceNotFoundError,
  ValidationError,
  findConfigRoot,
  requireConfigRoot,
  serializeResult,
  toError,
} from '../../lib';
import type { Result } from '../../lib/result';
import type {
  AgentCoreCliMcpDefs,
  AgentCoreGatewayTarget,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  ApiGatewayHttpMethod,
  ConnectorId,
  DirectoryPath,
  FilePath,
  PassthroughProtocolType,
} from '../../schema';
import {
  AgentCoreCliMcpDefsSchema,
  AgentCoreGatewayTargetSchema,
  CONNECTOR_ID_VALUES,
  ToolDefinitionSchema,
} from '../../schema';
import type { AddGatewayTargetOptions as CLIAddGatewayTargetOptions } from '../commands/add/types';
import { validateAddGatewayTargetOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import { translateConnector } from '../operations/connectors';
import type { RemovableGatewayTarget } from '../operations/remove/remove-gateway-target';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand, withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import {
  GATEWAY_TARGET_TYPE_MAP,
  GatewayTargetHost,
  OutboundAuthType,
  standardize,
} from '../telemetry/schemas/common-shapes.js';
import { getTemplateToolDefinitions, renderGatewayTargetTemplate } from '../templates/GatewayTargetRenderer';
import { requireTTY } from '../tui/guards/tty';
import type {
  ApiGatewayTargetConfig,
  ConnectorTargetConfig,
  GatewayTargetWizardState,
  LambdaFunctionArnTargetConfig,
  McpServerTargetConfig,
  SchemaBasedTargetConfig,
  WebSearchTargetConfig,
} from '../tui/screens/mcp/types';
import { DEFAULT_HANDLER, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from '../tui/screens/mcp/types';
import { BasePrimitive } from './BasePrimitive';
import { PASSTHROUGH_PROTOCOL_TYPES, SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent } from './types';
import { Option } from '@commander-js/extra-typings';
import type { Command } from '@commander-js/extra-typings';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

const MCP_DEFS_FILE = 'mcp-defs.json';

/**
 * Options for adding a gateway target (CLI-level).
 */
export interface AddGatewayTargetOptions {
  name: string;
  description?: string;
  language: 'Python' | 'TypeScript' | 'Other';
  gateway?: string;
  host?: 'Lambda' | 'AgentCoreRuntime';
}

/** Extract MCP-related fields from a project spec. */
function extractMcpSpec(project: AgentCoreProjectSpec): AgentCoreMcpSpec {
  return {
    agentCoreGateways: project.agentCoreGateways,
    mcpRuntimeTools: project.mcpRuntimeTools,
    unassignedTargets: project.unassignedTargets,
  };
}

/**
 * GatewayTargetPrimitive handles all gateway target add/remove operations.
 * Absorbs logic from create-mcp.ts (tool) and remove-gateway-target.ts.
 */
export class GatewayTargetPrimitive extends BasePrimitive<AddGatewayTargetOptions, RemovableGatewayTarget> {
  readonly kind = 'gateway-target';
  readonly label = 'Gateway Target';
  readonly primitiveSchema = AgentCoreGatewayTargetSchema;

  async add(options: AddGatewayTargetOptions): Promise<AddResult<{ toolName: string; sourcePath: string }>> {
    try {
      const config = this.buildGatewayTargetConfig(options);
      const result = await this.createToolFromWizard(config);
      return { success: true, toolName: result.toolName, sourcePath: result.projectPath };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(name: string): Promise<Result> {
    // Find the target by name to get its gateway info
    const tools = await this.getRemovable();
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { success: false, error: new ResourceNotFoundError(`Gateway target "${name}" not found.`) };
    }
    return this.removeGatewayTarget(tool);
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const tools = await this.getRemovable();
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Gateway target "${name}" not found.`);
    }
    return this.previewRemoveGatewayTarget(tool);
  }

  async getRemovable(): Promise<RemovableGatewayTarget[]> {
    try {
      const project = await this.readProjectSpec();
      const tools: RemovableGatewayTarget[] = [];

      // Gateway targets
      for (const gateway of project.agentCoreGateways) {
        for (const target of gateway.targets) {
          tools.push({
            name: target.name,
            type: 'gateway-target',
            gatewayName: gateway.name,
          });
        }
      }

      return tools;
    } catch {
      return [];
    }
  }

  /**
   * Preview removal of a specific gateway target (with full target info).
   */
  async previewRemoveGatewayTarget(tool: RemovableGatewayTarget): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    const mcpSpec = extractMcpSpec(project);
    const mcpDefs = this.configIO.configExists('mcpDefs') ? await this.configIO.readMcpDefs() : { tools: {} };

    const summary: string[] = [];
    const directoriesToDelete: string[] = [];
    const schemaChanges: SchemaChange[] = [];
    const projectRoot = this.configIO.getProjectRoot();

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    if (!gateway) {
      throw new Error(`Gateway "${tool.gatewayName}" not found.`);
    }

    const target = gateway.targets.find(t => t.name === tool.name);
    if (!target) {
      throw new Error(`Target "${tool.name}" not found in gateway "${tool.gatewayName}".`);
    }

    summary.push(`Removing gateway target: ${tool.name} (from ${tool.gatewayName})`);

    if (target.compute?.implementation && 'path' in target.compute.implementation) {
      const toolPath = target.compute.implementation.path;
      const toolDir = join(projectRoot, toolPath);
      if (existsSync(toolDir)) {
        directoriesToDelete.push(toolDir);
        summary.push(`Deleting directory: ${toolPath}`);
      }
    }

    for (const toolDef of target.toolDefinitions ?? []) {
      if (mcpDefs.tools[toolDef.name]) {
        summary.push(`Removing tool definition: ${toolDef.name}`);
      }
    }

    const afterMcpSpec = this.computeRemovedToolMcpSpec(mcpSpec, tool);
    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: { ...project, ...afterMcpSpec },
    });

    const afterMcpDefs = this.computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
    if (JSON.stringify(mcpDefs) !== JSON.stringify(afterMcpDefs)) {
      schemaChanges.push({
        file: 'agentcore/mcp-defs.json',
        before: mcpDefs,
        after: afterMcpDefs,
      });
    }

    return { summary, directoriesToDelete, schemaChanges };
  }

  /**
   * Remove a gateway target (with full target info).
   */
  async removeGatewayTarget(tool: RemovableGatewayTarget): Promise<Result> {
    try {
      const project = await this.readProjectSpec();
      const mcpSpec = extractMcpSpec(project);
      const mcpDefs = this.configIO.configExists('mcpDefs') ? await this.configIO.readMcpDefs() : { tools: {} };
      const projectRoot = this.configIO.getProjectRoot();

      // Find the tool path for deletion
      let toolPath: string | undefined;

      const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
      if (!gateway) {
        return { success: false, error: new ResourceNotFoundError(`Gateway "${tool.gatewayName}" not found.`) };
      }
      const target = gateway.targets.find(t => t.name === tool.name);
      if (!target) {
        return {
          success: false,
          error: new ResourceNotFoundError(`Target "${tool.name}" not found in gateway "${tool.gatewayName}".`),
        };
      }
      if (target.compute?.implementation && 'path' in target.compute.implementation) {
        toolPath = target.compute.implementation.path;
      }

      // Update project spec with MCP changes
      const newMcpSpec = this.computeRemovedToolMcpSpec(mcpSpec, tool);
      await this.writeProjectSpec({ ...project, ...newMcpSpec });

      // Update MCP defs
      const newMcpDefs = this.computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
      await this.configIO.writeMcpDefs(newMcpDefs);

      // Delete tool directory if it exists
      if (toolPath) {
        const toolDir = join(projectRoot, toolPath);
        if (existsSync(toolDir)) {
          await rm(toolDir, { recursive: true, force: true });
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  /**
   * Get list of existing tool names from MCP spec.
   */
  async getExistingToolNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      const toolNames: string[] = [];

      for (const gateway of project.agentCoreGateways) {
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

  registerCommands(addCmd: Command, removeCmd: Command): void {
    const typeDescription =
      'Target type (required): mcp-server, api-gateway, open-api-schema, smithy-model, lambda-function-arn, http-runtime, connector, passthrough [non-interactive]';

    // Reject repeated use of --exclude-domains. Domains must be passed as a
    // single comma-separated value.
    const excludeDomainsCoercer = (val: string, prev?: string) => {
      if (prev !== undefined) {
        throw new ValidationError(
          '--exclude-domains may only be specified once. Pass all domains as a single comma-separated value.'
        );
      }
      return val;
    };

    addCmd
      .command('gateway-target')
      .description('Add a target to a gateway for routing requests to backends')
      .option('--name <name>', 'Target name [non-interactive]')
      .option('--description <desc>', 'Target description [non-interactive]')
      .option('--gateway <name>', 'Gateway to attach this target to [non-interactive]')
      .option('--type <type>', typeDescription)
      .option(
        '--connector <id>',
        'Connector id (for connector type): bedrock-knowledge-bases or web-search [non-interactive]'
      )
      .option(
        '--knowledge-base-id <id>',
        'KB reference for connector type — either a project KB name (entry in knowledgeBases[]) or a 10-char Bedrock KB id for an external KB. [non-interactive]',
        (val: string, acc: string[]) => [...acc, val],
        [] as string[]
      )
      .option(
        '--exclude-domains <list>',
        'Comma-separated domains to exclude from results (for --connector web-search) [non-interactive]',
        excludeDomainsCoercer
      )
      .option('--endpoint <endpoint>', 'Server endpoint URL (for mcp-server type) [non-interactive]')
      .option('--language <lang>', 'Language of target code: Python, TypeScript, Other [non-interactive]')
      .option('--host <host>', 'Where to run the target: Lambda or AgentCoreRuntime [non-interactive]')
      .option(
        '--outbound-auth <type>',
        'Outbound auth type; valid values depend on --type (see "Auth" below) [non-interactive]'
      )
      .option('--credential-name <name>', 'Existing credential name for outbound auth [non-interactive]')
      .option(
        '--oauth-client-id <id>',
        'OAuth client ID — creates credential inline (for oauth auth) [non-interactive]'
      )
      .option(
        '--oauth-client-secret <secret>',
        'OAuth client secret — creates credential inline (for oauth auth) [non-interactive]'
      )
      .option(
        '--oauth-discovery-url <url>',
        'OAuth discovery URL — creates credential inline (for oauth auth) [non-interactive]'
      )
      .option('--oauth-scopes <scopes>', 'OAuth scopes, comma-separated (for oauth auth) [non-interactive]')
      .option('--rest-api-id <id>', 'REST API ID (for api-gateway type) [non-interactive]')
      .option('--stage <stage>', 'Deployment stage (for api-gateway type) [non-interactive]')
      .option('--tool-filter-path <path>', 'Tool filter path pattern, e.g. /pets/* [non-interactive]')
      .option('--tool-filter-methods <methods>', 'Comma-separated HTTP methods, e.g. GET,POST [non-interactive]')
      .option(
        '--schema <path>',
        'Schema file path or S3 URI (for open-api-schema / smithy-model type) [non-interactive]'
      )
      .option(
        '--schema-s3-account <id>',
        'S3 bucket owner account ID for cross-account access (for schema on S3) [non-interactive]'
      )
      .option('--lambda-arn <arn>', 'Lambda function ARN (for lambda-function-arn type) [non-interactive]')
      .option(
        '--tool-schema-file <path>',
        'Tool schema JSON file path (for lambda-function-arn type) [non-interactive]'
      )
      .option('--runtime <name>', 'Runtime from your project (for http-runtime type) [non-interactive]')
      .option('--runtime-endpoint <name>', 'Runtime endpoint / version alias (for http-runtime type) [non-interactive]')
      // Passthrough-only flags.
      .addOption(
        new Option('--passthrough-endpoint <url>', 'HTTPS endpoint URL for passthrough targets [non-interactive]')
      )
      .addOption(
        new Option(
          '--passthrough-protocol <type>',
          'Passthrough protocol: MCP | A2A | INFERENCE | CUSTOM (default: CUSTOM) [non-interactive]'
        )
      )
      .addOption(
        new Option(
          '--stickiness-identifier <expr>',
          'Session routing expression for passthrough targets [non-interactive]'
        )
      )
      .addOption(
        new Option('--stickiness-timeout <seconds>', 'Sticky session timeout in seconds (1-86400) [non-interactive]')
      )
      .addOption(
        new Option(
          '--signing-service <name>',
          'SigV4 signing service name for passthrough GATEWAY_IAM_ROLE auth [non-interactive]'
        )
      )
      .addOption(
        new Option(
          '--signing-region <region>',
          'SigV4 signing region for passthrough (defaults to project region) [non-interactive]'
        )
      )
      .option('--json', 'Output as JSON [non-interactive]')
      .addHelpText(
        'after',
        `
Target types and their options:

  http-runtime — Route to an AgentCore runtime
    --runtime <name>               Runtime from your project
    --runtime-endpoint <name>      Endpoint / version alias (optional)

  mcp-server — Connect to an MCP-compatible server
    --endpoint <url>               Server endpoint URL
    --host <host>                  Lambda or AgentCoreRuntime
    --language <lang>              Python, TypeScript, or Other

  api-gateway — Connect to an Amazon API Gateway REST API
    --rest-api-id <id>             REST API ID
    --stage <stage>                Deployment stage

  open-api-schema / smithy-model — Auto-derive tools from a schema
    --schema <path>                Schema file path or S3 URI
    --schema-s3-account <id>       S3 bucket owner account ID

  lambda-function-arn — Connect to an AWS Lambda function
    --lambda-arn <arn>             Lambda function ARN
    --tool-schema-file <path>      Tool schema JSON file

  connector — Wire a managed AWS connector (bedrock-knowledge-bases, web-search)
    --connector <id>               bedrock-knowledge-bases or web-search
    --knowledge-base-id <id>       Project KB name or 10-char external KB id (for KB connectors)
    --exclude-domains <list>       Comma-separated domains to exclude (for web-search connector)

  passthrough — Route to an external HTTPS endpoint
    --passthrough-endpoint <url>   HTTPS endpoint URL
    --stickiness-identifier <expr> Session routing expression (optional)
    --stickiness-timeout <seconds> Sticky session timeout in seconds (optional)

  Auth (--outbound-auth <type>, --credential-name <name>) — valid types per target:
    mcp-server                     oauth or none
    lambda-function-arn            oauth or none
    http-runtime                   oauth or none
    open-api-schema                oauth or api-key (required)
    api-gateway                    api-key or none
    smithy-model                   none (uses gateway IAM role)
    passthrough                    gateway-iam-role, oauth, or jwt-passthrough
`
      )
      .action(async (rawOptions: Record<string, string | string[] | boolean | undefined>) => {
        // Commander camelCases --outbound-auth to outboundAuth, but our types use outboundAuthType
        if (rawOptions.outboundAuth && !rawOptions.outboundAuthType) {
          rawOptions.outboundAuthType = rawOptions.outboundAuth;
          delete rawOptions.outboundAuth;
        }
        const cliOptions = rawOptions as unknown as CLIAddGatewayTargetOptions;
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }

        const userPassedAnyFlag = Object.entries(rawOptions).some(
          ([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)
        );
        if (!userPassedAnyFlag) {
          try {
            requireTTY();
            const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/add/AddFlow'),
            ]);
            const { clear, unmount } = render(
              React.createElement(AddFlow, {
                isInteractive: false,
                initialResource: 'gateway-target',
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
            return;
          } catch (error) {
            console.error(getErrorMessage(error));
            process.exit(1);
          }
        }

        await runCliCommand('add.gateway-target', !!cliOptions.json, async () => {
          const validation = await validateAddGatewayTargetOptions(cliOptions);
          if (!validation.valid) {
            throw new ValidationError(validation.error!);
          }

          // Map CLI flag values to internal types
          const outboundAuthMap: Record<string, 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH'> =
            {
              oauth: 'OAUTH',
              'api-key': 'API_KEY',
              api_key: 'API_KEY',
              none: 'NONE',
              gateway_iam_role: 'GATEWAY_IAM_ROLE',
              'gateway-iam-role': 'GATEWAY_IAM_ROLE',
              jwt_passthrough: 'JWT_PASSTHROUGH',
              'jwt-passthrough': 'JWT_PASSTHROUGH',
            };

          const cliType = cliOptions.type ?? '';
          const telemetryTargetType = GATEWAY_TARGET_TYPE_MAP[cliType] ?? ('unknown' as const);
          const telemetryOutboundAuth = standardize(
            OutboundAuthType,
            (cliOptions.outboundAuthType ?? 'none').replaceAll('_', '-')
          );
          const telemetryHost = standardize(GatewayTargetHost, cliOptions.host ?? 'lambda');
          const telemetryAttrs = {
            gateway_target_type: telemetryTargetType,
            gateway_target_host: telemetryHost,
            outbound_auth_type: telemetryOutboundAuth,
          };

          // Handle API Gateway targets (no code generation)
          if (cliOptions.type === 'apiGateway') {
            const config: ApiGatewayTargetConfig = {
              targetType: 'apiGateway',
              name: cliOptions.name!,
              gateway: cliOptions.gateway!,
              restApiId: cliOptions.restApiId!,
              stage: cliOptions.stage!,
              toolFilters: cliOptions.toolFilterPath
                ? [
                    {
                      filterPath: cliOptions.toolFilterPath,
                      methods: (cliOptions.toolFilterMethods?.split(',').map(m => m.trim()) ?? [
                        'GET',
                      ]) as ApiGatewayHttpMethod[],
                    },
                  ]
                : undefined,
              ...(cliOptions.outboundAuthType
                ? {
                    outboundAuth: {
                      type: (outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE') as
                        | 'API_KEY'
                        | 'NONE',
                      credentialName: cliOptions.credentialName,
                    },
                  }
                : {}),
            };
            const result = await this.createApiGatewayTarget(config);
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return telemetryAttrs;
          }

          // Handle schema-based targets (OpenAPI / Smithy)
          if ((cliOptions.type === 'openApiSchema' || cliOptions.type === 'smithyModel') && cliOptions.schema) {
            const isS3 = cliOptions.schema.startsWith('s3://');
            const schemaSource = isS3
              ? {
                  s3: {
                    uri: cliOptions.schema,
                    ...(cliOptions.schemaS3Account ? { bucketOwnerAccountId: cliOptions.schemaS3Account } : {}),
                  },
                }
              : { inline: { path: cliOptions.schema } };

            const config: SchemaBasedTargetConfig = {
              name: cliOptions.name!,
              targetType: cliOptions.type,
              schemaSource,
              gateway: cliOptions.gateway!,
              ...(cliOptions.outboundAuthType
                ? {
                    outboundAuth: {
                      type: (outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE') as
                        | 'OAUTH'
                        | 'API_KEY'
                        | 'NONE',
                      credentialName: cliOptions.credentialName,
                    },
                  }
                : {}),
            };
            const result = await this.createSchemaBasedGatewayTarget(config);
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return telemetryAttrs;
          }

          // Handle Lambda Function ARN targets (no code generation)
          if (cliOptions.type === 'lambdaFunctionArn') {
            const config = {
              targetType: 'lambdaFunctionArn' as const,
              name: cliOptions.name!,
              gateway: cliOptions.gateway!,
              lambdaArn: cliOptions.lambdaArn!,
              toolSchemaFile: cliOptions.toolSchemaFile!,
            };
            const result = await this.createLambdaFunctionArnTarget(config);
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return { ...telemetryAttrs };
          }

          // Handle HTTP runtime targets (no code generation)
          if (cliOptions.type === 'httpRuntime') {
            const result = await this.createHttpRuntimeTarget({
              name: cliOptions.name!,
              gateway: cliOptions.gateway!,
              runtime: cliOptions.runtime!,
              endpoint: cliOptions.runtimeEndpoint ?? cliOptions.endpoint,
              outboundAuth:
                cliOptions.outboundAuthType && cliOptions.outboundAuthType !== 'NONE'
                  ? {
                      type: outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE',
                      credentialName: cliOptions.credentialName,
                      scopes: cliOptions.oauthScopes?.split(',').map(s => s.trim()),
                    }
                  : undefined,
            });
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return telemetryAttrs;
          }

          // Handle connector targets (managed-service backed: KB, web-search)
          if (cliOptions.type === 'connector') {
            const validConnectors = CONNECTOR_ID_VALUES.join(', ');
            if (!cliOptions.connector) {
              throw new ValidationError(`--connector is required for connector targets (${validConnectors}).`);
            }
            if (!(CONNECTOR_ID_VALUES as readonly string[]).includes(cliOptions.connector)) {
              throw new ValidationError(
                `Unknown --connector value '${cliOptions.connector}'. Valid: ${validConnectors}.`
              );
            }
            const connectorId = cliOptions.connector as ConnectorId;

            // Web search connector
            if (connectorId === 'web-search') {
              const excludeDomains =
                typeof cliOptions.excludeDomains === 'string'
                  ? cliOptions.excludeDomains
                      .split(',')
                      .map((d: string) => d.trim())
                      .filter((d: string) => d.length > 0)
                  : undefined;
              const config: WebSearchTargetConfig = {
                targetType: 'webSearch',
                name: cliOptions.name!,
                gateway: cliOptions.gateway!,
                ...(excludeDomains && excludeDomains.length > 0 ? { excludeDomains } : {}),
              };
              const result = await this.createWebSearchGatewayTarget(config);
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: true, toolName: result.toolName }));
              } else {
                const suffix = config.excludeDomains ? ` (excludeDomains=${config.excludeDomains.join(',')})` : '';
                console.log(`Added web-search gateway target '${result.toolName}' on '${config.gateway}'${suffix}`);
              }
              return { ...telemetryAttrs, gateway_target_type: 'web-search' as const };
            }

            // KB connectors require --knowledge-base-id
            const kbRefs = cliOptions.knowledgeBaseId ?? [];
            if (kbRefs.length === 0) {
              throw new ValidationError(`--knowledge-base-id is required for --connector ${connectorId}.`);
            }

            if (kbRefs.length > 1) {
              throw new ValidationError(
                '--knowledge-base-id may only be specified once for --connector bedrock-knowledge-bases.'
              );
            }

            const resolvedName =
              cliOptions.name ?? `kb-${cliOptions.gateway}-${kbRefs[0]}`.replace(/_/g, '-').slice(0, 128);

            const config: ConnectorTargetConfig = {
              targetType: 'connector',
              name: resolvedName,
              gateway: cliOptions.gateway!,
              connectorId,
              knowledgeBaseId: kbRefs[0]!,
              ...(cliOptions.description && { description: cliOptions.description }),
            };
            const result = await this.createConnectorGatewayTarget(config);
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(
                `Added connector gateway target '${result.toolName}' on '${config.gateway}' → ${config.connectorId} (KB ${kbRefs[0]})`
              );
            }
            return telemetryAttrs;
          }

          // Handle passthrough targets (no code generation)
          if (cliOptions.type === 'passthrough') {
            const passthroughEndpoint = (cliOptions as Record<string, string | undefined>).passthroughEndpoint;
            if (!passthroughEndpoint) {
              throw new ValidationError('--passthrough-endpoint is required for passthrough type');
            }
            const stickinessIdentifier = (cliOptions as Record<string, string | undefined>).stickinessIdentifier;
            const stickinessTimeoutRaw = (cliOptions as Record<string, string | undefined>).stickinessTimeout;
            const stickinessTimeout = stickinessTimeoutRaw ? parseInt(stickinessTimeoutRaw, 10) : undefined;
            const signingService = (rawOptions as Record<string, string | undefined>).signingService;
            const signingRegion = (rawOptions as Record<string, string | undefined>).signingRegion;
            const protocolTypeRaw = (rawOptions as Record<string, string | undefined>).passthroughProtocol;
            const protocolType = protocolTypeRaw?.toUpperCase() ?? 'CUSTOM';
            if (!PASSTHROUGH_PROTOCOL_TYPES.includes(protocolType as PassthroughProtocolType)) {
              throw new ValidationError(
                `Invalid --passthrough-protocol "${protocolTypeRaw}". Must be one of: ${PASSTHROUGH_PROTOCOL_TYPES.join(', ')}`
              );
            }

            // Build outboundAuth based on the auth type
            let passthroughOutboundAuth:
              | { type: string; credentialName?: string; scopes?: string[]; service?: string; region?: string }
              | undefined;
            if (cliOptions.outboundAuthType) {
              const mappedAuthType = outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE';
              if (mappedAuthType === 'GATEWAY_IAM_ROLE') {
                if (!signingService) {
                  throw new ValidationError(
                    '--signing-service is required when --outbound-auth is GATEWAY_IAM_ROLE for passthrough targets'
                  );
                }
                passthroughOutboundAuth = {
                  type: 'GATEWAY_IAM_ROLE',
                  service: signingService,
                  ...(signingRegion && { region: signingRegion }),
                };
              } else if (mappedAuthType === 'JWT_PASSTHROUGH') {
                passthroughOutboundAuth = { type: 'JWT_PASSTHROUGH' };
              } else if (mappedAuthType === 'OAUTH') {
                passthroughOutboundAuth = {
                  type: 'OAUTH',
                  credentialName: cliOptions.credentialName,
                  scopes: cliOptions.oauthScopes?.split(',').map(s => s.trim()),
                };
              } else if (mappedAuthType !== 'NONE') {
                passthroughOutboundAuth = {
                  type: mappedAuthType,
                  credentialName: cliOptions.credentialName,
                  scopes: cliOptions.oauthScopes?.split(',').map(s => s.trim()),
                };
              }
            }

            const result = await this.createPassthroughTarget({
              name: cliOptions.name!,
              gateway: cliOptions.gateway!,
              passthroughEndpoint,
              protocolType: protocolType as PassthroughProtocolType,
              stickinessIdentifier,
              stickinessTimeout,
              outboundAuth: passthroughOutboundAuth,
            });
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return telemetryAttrs;
          }

          // Handle MCP server targets (existing endpoint, no code generation)
          if (cliOptions.type === 'mcpServer' && cliOptions.endpoint) {
            const config: McpServerTargetConfig = {
              targetType: 'mcpServer',
              name: cliOptions.name!,
              description: cliOptions.description ?? `Tool for ${cliOptions.name!}`,
              endpoint: cliOptions.endpoint,
              gateway: cliOptions.gateway!,
              toolDefinition: {
                name: cliOptions.name!,
                description: cliOptions.description ?? `Tool for ${cliOptions.name!}`,
                inputSchema: { type: 'object' },
              },
              ...(cliOptions.outboundAuthType
                ? {
                    outboundAuth: {
                      type: (outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE') as
                        | 'OAUTH'
                        | 'API_KEY'
                        | 'NONE',
                      credentialName: cliOptions.credentialName,
                    },
                  }
                : {}),
            };
            const result = await this.createExternalGatewayTarget(config);
            const output = {
              success: true,
              toolName: result.toolName,
              sourcePath: result.projectPath || undefined,
            };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            return telemetryAttrs;
          }

          const result = await this.add({
            name: cliOptions.name!,
            description: cliOptions.description,
            language: cliOptions.language ?? 'Python',
            gateway: cliOptions.gateway,
            host: cliOptions.host,
          });

          if (!result.success) {
            throw result.error;
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            console.log(`Added gateway target '${result.toolName}'`);
            if (result.sourcePath) {
              console.log(`Tool code: ${result.sourcePath}`);
            }
          }

          return telemetryAttrs;
        });
      });

    removeCmd
      .command('gateway-target')
      .description('Remove a gateway target from the project')
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              console.log(JSON.stringify({ success: false, error: '--name is required' }));
              process.exit(1);
            }

            const result = await withCommandRunTelemetry('remove.gateway-target', {}, () =>
              this.remove(cliOptions.name!)
            );
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed gateway target '${cliOptions.name}'` : undefined,
                note: result.success ? SOURCE_CODE_NOTE : undefined,
                error: !result.success ? result.error.message : undefined,
              })
            );
            process.exit(result.success ? 0 : 1);
          } else {
            requireTTY();
            const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/remove'),
            ]);
            const { clear, unmount } = render(
              React.createElement(RemoveFlow, {
                isInteractive: false,
                force: cliOptions.yes,
                initialResourceType: this.kind,
                initialResourceName: cliOptions.name,
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(`Error: ${getErrorMessage(error)}`);
          }
          process.exit(1);
        }
      });
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Create an external gateway target that connects to an existing MCP server endpoint.
   * Unlike `add()` which scaffolds new code, this registers an existing endpoint URL.
   */
  async createExternalGatewayTarget(config: McpServerTargetConfig): Promise<{ toolName: string; projectPath: string }> {
    const project = await this.readProjectSpec();

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

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    // Check for duplicate target name
    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    gateway.targets.push(target);

    await this.writeProjectSpec(project);

    return { toolName: config.name, projectPath: '' };
  }

  /**
   * Create an API Gateway target that connects to an existing Amazon API Gateway REST API.
   * Unlike `add()` which scaffolds new code, this registers an existing REST API.
   */
  async createApiGatewayTarget(config: ApiGatewayTargetConfig): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: config.restApiId,
        stage: config.stage,
        apiGatewayToolConfiguration: {
          toolFilters: config.toolFilters ?? [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
      ...(config.outboundAuth && { outboundAuth: config.outboundAuth }),
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create a schema-based gateway target (OpenAPI or Smithy).
   * No code generation — tools are auto-derived from the schema by the service.
   */
  async createSchemaBasedGatewayTarget(config: SchemaBasedTargetConfig): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: config.targetType,
      schemaSource: config.schemaSource,
      ...(config.outboundAuth && { outboundAuth: config.outboundAuth }),
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create a Lambda Function ARN target that connects to an existing Lambda function.
   * Unlike `add()` which scaffolds new code, this registers an existing Lambda function ARN.
   */
  async createLambdaFunctionArnTarget(config: LambdaFunctionArnTargetConfig): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: config.lambdaArn,
        toolSchemaFile: config.toolSchemaFile,
      },
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create an HTTP runtime target that references an existing agent runtime.
   * No code generation — this registers a runtime reference for HTTP routing.
   */
  async createHttpRuntimeTarget(config: {
    name: string;
    gateway: string;
    runtime: string;
    endpoint?: string;
    outboundAuth?: { type: string; credentialName?: string; scopes?: string[] };
  }): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'httpRuntime',
      httpRuntime: {
        runtime: config.runtime,
        ...(config.endpoint && { runtimeEndpoint: config.endpoint }),
      },
      ...(config.outboundAuth &&
        config.outboundAuth.type !== 'NONE' && {
          outboundAuth: {
            type: config.outboundAuth.type as 'OAUTH' | 'API_KEY',
            credentialName: config.outboundAuth.credentialName!,
            ...(config.outboundAuth.scopes && { scopes: config.outboundAuth.scopes }),
          },
        }),
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create a connector-typed gateway target backed by a managed AWS service
   * (bedrock-knowledge-bases).
   *
   * Project-owned KB: config.knowledgeBaseId is a knowledgeBases[] entry name;
   * the L3 resolves it at synth time via application.knowledgeBases.
   * External KB: config.knowledgeBaseId is a 10-character literal KB ID; the
   * L3 passes it through verbatim.
   */
  async createConnectorGatewayTarget(config: ConnectorTargetConfig): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const configurations = translateConnector({
      connectorId: 'bedrock-knowledge-bases',
      input: { knowledgeBaseId: config.knowledgeBaseId },
    });

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'connector',
      connectorId: 'bedrock-knowledge-bases',
      configurations,
    } as AgentCoreGatewayTarget;

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create a passthrough target that routes HTTP traffic to an external HTTPS endpoint.
   * No code generation — this registers an endpoint for HTTP passthrough.
   */
  async createPassthroughTarget(config: {
    name: string;
    gateway: string;
    passthroughEndpoint: string;
    protocolType?: PassthroughProtocolType;
    stickinessIdentifier?: string;
    stickinessTimeout?: number;
    outboundAuth?: { type: string; credentialName?: string; scopes?: string[]; service?: string; region?: string };
  }): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    // Build outboundAuth object based on auth type
    let outboundAuth: AgentCoreGatewayTarget['outboundAuth'];
    if (config.outboundAuth && config.outboundAuth.type !== 'NONE') {
      if (config.outboundAuth.type === 'GATEWAY_IAM_ROLE') {
        outboundAuth = {
          type: 'GATEWAY_IAM_ROLE',
          service: config.outboundAuth.service,
          ...(config.outboundAuth.region && { region: config.outboundAuth.region }),
        };
      } else if (config.outboundAuth.type === 'JWT_PASSTHROUGH') {
        outboundAuth = { type: 'JWT_PASSTHROUGH' };
      } else {
        outboundAuth = {
          type: config.outboundAuth.type as 'OAUTH' | 'API_KEY',
          credentialName: config.outboundAuth.credentialName!,
          ...(config.outboundAuth.scopes && { scopes: config.outboundAuth.scopes }),
        };
      }
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'passthrough',
      passthrough: {
        endpoint: config.passthroughEndpoint,
        protocolType: config.protocolType ?? 'CUSTOM',
        ...(config.stickinessIdentifier && {
          stickinessConfiguration: {
            identifier: config.stickinessIdentifier,
            ...(config.stickinessTimeout && { timeout: config.stickinessTimeout }),
          },
        }),
      },
      ...(outboundAuth && { outboundAuth }),
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  /**
   * Create an Amazon Web Search gateway target. The target is invoked via the
   * gateway's IAM role; the only admin-configurable parameter is an optional
   * list of domains to exclude from results.
   */
  async createWebSearchGatewayTarget(config: WebSearchTargetConfig): Promise<{ toolName: string }> {
    const project = await this.readProjectSpec();

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const configurations = translateConnector({
      connectorId: 'web-search',
      input: { excludeDomains: config.excludeDomains },
    });

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'connector',
      connectorId: 'web-search',
      configurations,
    } as AgentCoreGatewayTarget;

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    return { toolName: config.name };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════

  private buildGatewayTargetConfig(options: AddGatewayTargetOptions): GatewayTargetWizardState {
    const sourcePath = `${APP_DIR}/${MCP_APP_SUBDIR}/${options.name}`;
    const description = options.description ?? `Tool for ${options.name}`;
    return {
      name: options.name,
      description,
      sourcePath,
      language: options.language,
      host: options.host ?? 'AgentCoreRuntime',
      toolDefinition: {
        name: options.name,
        description,
        inputSchema: { type: 'object' },
      },
      gateway: options.gateway,
    };
  }

  private async createToolFromWizard(
    config: GatewayTargetWizardState
  ): Promise<{ mcpDefsPath: string; toolName: string; projectPath: string }> {
    this.validateGatewayTargetLanguage(config.language!);

    const project = await this.readProjectSpec();

    const toolDefs =
      config.host === 'Lambda' ? getTemplateToolDefinitions(config.name, config.host) : [config.toolDefinition!];

    for (const toolDef of toolDefs) {
      ToolDefinitionSchema.parse(toolDef);
    }

    if (!config.gateway) {
      throw new Error('Gateway name is required for gateway targets.');
    }

    const gateway = project.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    for (const toolDef of toolDefs) {
      for (const existingTarget of gateway.targets) {
        if ((existingTarget.toolDefinitions ?? []).some(t => t.name === toolDef.name)) {
          throw new Error(`Tool "${toolDef.name}" already exists in gateway "${gateway.name}".`);
        }
      }
    }

    if (config.language === 'Other') {
      throw new Error('Language "Other" is not yet supported for gateway targets. Use Python or TypeScript.');
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: config.host === 'AgentCoreRuntime' ? 'mcpServer' : 'lambda',
      toolDefinitions: toolDefs,
      compute:
        config.host === 'Lambda'
          ? {
              host: 'Lambda',
              implementation: {
                path: config.sourcePath!,
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
                path: config.sourcePath!,
                language: 'Python',
                handler: 'server.py:main',
              },
              runtime: {
                artifact: 'CodeZip',
                pythonVersion: DEFAULT_PYTHON_VERSION,
                name: config.name,
                entrypoint: 'server.py:main' as FilePath,
                codeLocation: config.sourcePath! as DirectoryPath,
                networkMode: 'PUBLIC',
              },
            },
    };

    gateway.targets.push(target);
    await this.writeProjectSpec(project);

    // Update mcp-defs.json
    const mcpDefsPath = this.resolveMcpDefsPath();
    try {
      const mcpDefs = await this.readMcpDefs(mcpDefsPath);
      for (const toolDef of toolDefs) {
        if (mcpDefs.tools[toolDef.name]) {
          throw new Error(`Tool definition "${toolDef.name}" already exists in mcp-defs.json.`);
        }
        mcpDefs.tools[toolDef.name] = toolDef;
      }
      await this.writeMcpDefs(mcpDefsPath, mcpDefs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`MCP saved, but failed to update mcp-defs.json: ${message}`);
    }

    // Render gateway target project template
    const configRoot = requireConfigRoot();
    const projectRoot = dirname(configRoot);
    const absoluteSourcePath = join(projectRoot, config.sourcePath!);
    await renderGatewayTargetTemplate(config.name, absoluteSourcePath, config.language, config.host);

    return { mcpDefsPath, toolName: config.name, projectPath: config.sourcePath! };
  }

  private validateGatewayTargetLanguage(language: string): asserts language is 'Python' | 'TypeScript' | 'Other' {
    if (language !== 'Python' && language !== 'TypeScript' && language !== 'Other') {
      throw new Error(`Gateway targets for language "${language}" are not yet supported.`);
    }
  }

  private resolveMcpDefsPath(): string {
    return join(requireConfigRoot(), MCP_DEFS_FILE);
  }

  private async readMcpDefs(filePath: string): Promise<AgentCoreCliMcpDefs> {
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

  private async writeMcpDefs(filePath: string, data: AgentCoreCliMcpDefs): Promise<void> {
    const configRoot = requireConfigRoot();
    await mkdir(configRoot, { recursive: true });
    const content = JSON.stringify(data, null, 2);
    await writeFile(filePath, content, 'utf-8');
  }

  private computeRemovedToolMcpSpec(mcpSpec: AgentCoreMcpSpec, tool: RemovableGatewayTarget): AgentCoreMcpSpec {
    return {
      ...mcpSpec,
      agentCoreGateways: mcpSpec.agentCoreGateways.map(g => {
        if (g.name !== tool.gatewayName) return g;
        return {
          ...g,
          targets: g.targets.filter(t => t.name !== tool.name),
        };
      }),
    };
  }

  private computeRemovedToolMcpDefs(
    mcpSpec: AgentCoreMcpSpec,
    mcpDefs: AgentCoreCliMcpDefs,
    tool: RemovableGatewayTarget
  ): AgentCoreCliMcpDefs {
    const toolNamesToRemove: string[] = [];

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    const target = gateway?.targets.find(t => t.name === tool.name);
    if (target) {
      for (const toolDef of target.toolDefinitions ?? []) {
        toolNamesToRemove.push(toolDef.name);
      }
    }

    const newTools = { ...mcpDefs.tools };
    for (const name of toolNamesToRemove) {
      delete newTools[name];
    }

    return { ...mcpDefs, tools: newTools };
  }
}
