import type {
  AgentCoreGateway,
  AgentCoreGatewayTarget,
  AgentCoreProjectSpec,
  AuthorizerConfig,
  CustomClaimValidation,
  GatewayAuthorizerType,
  GatewayExceptionLevel,
  GatewayPolicyEngineConfiguration,
  OutboundAuth,
} from '../../../schema';
import type { GatewayDetail, GatewayTargetDetail } from '../../aws/agentcore-control';
import {
  getGatewayDetail,
  getGatewayTargetDetail,
  listAllGatewayTargets,
  listAllGateways,
} from '../../aws/agentcore-control';
import { isAccessDeniedError } from '../../errors';
import { ANSI, NAME_REGEX } from './constants';
import { executeCdkImportPipeline } from './import-pipeline';
import {
  failResult,
  findResourceInDeployedState,
  parseAndValidateArn,
  resolveImportContext,
  toStackName,
} from './import-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult, ResourceToImport } from './types';
import type { Command } from '@commander-js/extra-typings';

// ============================================================================
// AWS → CLI Schema Mapping
// ============================================================================

/**
 * Map GetGatewayTarget response to CLI AgentCoreGatewayTarget schema.
 * Determines target type from the targetConfiguration.mcp union.
 */
function toGatewayTargetSpec(
  detail: GatewayTargetDetail,
  credentials: Map<string, string>,
  onProgress: (msg: string) => void
): AgentCoreGatewayTarget | undefined {
  const mcp = detail.targetConfiguration?.mcp;
  if (!mcp) {
    onProgress(`Warning: Target "${detail.name}" has no MCP configuration, skipping`);
    return undefined;
  }

  const outboundAuth = resolveOutboundAuth(detail, credentials, onProgress);

  // MCP Server (external endpoint)
  if (mcp.mcpServer) {
    return {
      name: detail.name,
      targetType: 'mcpServer',
      endpoint: mcp.mcpServer.endpoint,
      ...(outboundAuth && { outboundAuth }),
    };
  }

  // API Gateway
  if (mcp.apiGateway) {
    const apigw = mcp.apiGateway;
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    const target: AgentCoreGatewayTarget = {
      name: detail.name,
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: apigw.restApiId,
        stage: apigw.stage,
        apiGatewayToolConfiguration: {
          toolFilters: (apigw.apiGatewayToolConfiguration?.toolFilters ?? []).map(f => ({
            filterPath: f.filterPath,
            methods: f.methods,
          })) as any,
          ...(apigw.apiGatewayToolConfiguration?.toolOverrides && {
            toolOverrides: apigw.apiGatewayToolConfiguration.toolOverrides.map(o => ({
              name: o.name,
              path: o.path,
              method: o.method,
              ...(o.description && { description: o.description }),
            })),
          }),
        },
      } as any,
      ...(outboundAuth && { outboundAuth }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    return target;
  }

  // OpenAPI Schema
  if (mcp.openApiSchema) {
    const schema = mcp.openApiSchema;
    if (schema.s3?.uri) {
      return {
        name: detail.name,
        targetType: 'openApiSchema',
        schemaSource: {
          s3: {
            uri: schema.s3.uri,
            ...(schema.s3.bucketOwnerAccountId && { bucketOwnerAccountId: schema.s3.bucketOwnerAccountId }),
          },
        },
        ...(outboundAuth && { outboundAuth }),
      };
    }
    onProgress(`Warning: Target "${detail.name}" (openApiSchema) has no S3 URI, skipping`);
    return undefined;
  }

  // Smithy Model
  if (mcp.smithyModel) {
    const schema = mcp.smithyModel;
    if (schema.s3?.uri) {
      return {
        name: detail.name,
        targetType: 'smithyModel',
        schemaSource: {
          s3: {
            uri: schema.s3.uri,
            ...(schema.s3.bucketOwnerAccountId && { bucketOwnerAccountId: schema.s3.bucketOwnerAccountId }),
          },
        },
        ...(outboundAuth && { outboundAuth }),
      };
    }
    onProgress(`Warning: Target "${detail.name}" (smithyModel) has no S3 URI, skipping`);
    return undefined;
  }

  // Lambda (compute-backed) → map to lambdaFunctionArn
  if (mcp.lambda) {
    const lambdaArn = mcp.lambda.lambdaArn;
    if (!lambdaArn) {
      onProgress(`Warning: Target "${detail.name}" (lambda) has no ARN, skipping`);
      return undefined;
    }

    // Extract tool schema S3 URI if available
    /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const toolSchema = mcp.lambda.toolSchema;
    const s3Uri: string | undefined = toolSchema?.s3?.uri;
    /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

    if (s3Uri) {
      onProgress(`Mapping compute-backed Lambda target "${detail.name}" to lambdaFunctionArn type`);
      return {
        name: detail.name,
        targetType: 'lambdaFunctionArn',
        lambdaFunctionArn: {
          lambdaArn,
          toolSchemaFile: s3Uri,
        },
        ...(outboundAuth && { outboundAuth }),
      };
    }

    // Lambda without S3 schema — can't import as lambdaFunctionArn since toolSchemaFile is required
    onProgress(`Warning: Target "${detail.name}" (lambda) has inline tool schema, which cannot be imported. Skipping.`);
    return undefined;
  }

  onProgress(`Warning: Target "${detail.name}" has an unrecognized target type, skipping`);
  return undefined;
}

/**
 * Resolve outbound auth from credential provider configurations.
 */
function resolveOutboundAuth(
  detail: GatewayTargetDetail,
  credentials: Map<string, string>,
  _onProgress: (msg: string) => void
): OutboundAuth | undefined {
  const configs = detail.credentialProviderConfigurations;
  if (!configs || configs.length === 0) return undefined;

  for (const config of configs) {
    if (config.credentialProviderType === 'OAUTH' && config.credentialProvider?.oauthCredentialProvider) {
      const providerArn = config.credentialProvider.oauthCredentialProvider.providerArn;
      const credentialName = credentials.get(providerArn);
      if (credentialName) {
        return {
          type: 'OAUTH',
          credentialName,
          ...(config.credentialProvider.oauthCredentialProvider.scopes?.length && {
            scopes: config.credentialProvider.oauthCredentialProvider.scopes,
          }),
        };
      }
      throw new Error(
        `Target "${detail.name}" uses an OAuth credential provider not found in this project's deployed state. ` +
          'Import the credential first with `agentcore add credential` and re-run.'
      );
    }

    if (config.credentialProviderType === 'API_KEY' && config.credentialProvider?.apiKeyCredentialProvider) {
      const providerArn = config.credentialProvider.apiKeyCredentialProvider.providerArn;
      const credentialName = credentials.get(providerArn);
      if (credentialName) {
        return { type: 'API_KEY', credentialName };
      }
      throw new Error(
        `Target "${detail.name}" uses an API Key credential provider not found in this project's deployed state. ` +
          'Import the credential first with `agentcore add credential` and re-run.'
      );
    }

    // GATEWAY_IAM_ROLE — no outbound auth needed
  }

  return undefined;
}

/**
 * Map GetGateway + GetGatewayTarget[] responses to CLI AgentCoreGateway schema.
 * @internal
 */
export function toGatewaySpec(
  gateway: GatewayDetail,
  targets: AgentCoreGatewayTarget[],
  localName: string
): AgentCoreGateway {
  const authorizerType = (gateway.authorizerType ?? 'NONE') as GatewayAuthorizerType;

  let authorizerConfiguration: AuthorizerConfig | undefined;
  if (authorizerType === 'CUSTOM_JWT' && gateway.authorizerConfiguration?.customJwtAuthorizer) {
    const jwt = gateway.authorizerConfiguration.customJwtAuthorizer;
    authorizerConfiguration = {
      customJwtAuthorizer: {
        discoveryUrl: jwt.discoveryUrl,
        ...(jwt.allowedAudience?.length && { allowedAudience: jwt.allowedAudience }),
        ...(jwt.allowedClients?.length && { allowedClients: jwt.allowedClients }),
        ...(jwt.allowedScopes?.length && { allowedScopes: jwt.allowedScopes }),
        ...(jwt.customClaims?.length && {
          customClaims: jwt.customClaims.map(
            (c): CustomClaimValidation => ({
              inboundTokenClaimName: c.inboundTokenClaimName,
              inboundTokenClaimValueType: c.inboundTokenClaimValueType as 'STRING' | 'STRING_ARRAY',
              authorizingClaimMatchValue: {
                claimMatchOperator: c.authorizingClaimMatchValue.claimMatchOperator as
                  | 'EQUALS'
                  | 'CONTAINS'
                  | 'CONTAINS_ANY',
                claimMatchValue: {
                  ...(c.authorizingClaimMatchValue.claimMatchValue.matchValueString && {
                    matchValueString: c.authorizingClaimMatchValue.claimMatchValue.matchValueString,
                  }),
                  ...(c.authorizingClaimMatchValue.claimMatchValue.matchValueStringList && {
                    matchValueStringList: c.authorizingClaimMatchValue.claimMatchValue.matchValueStringList,
                  }),
                },
              },
            })
          ),
        }),
      },
    };
  }

  const enableSemanticSearch = gateway.protocolConfiguration?.mcp?.searchType === 'SEMANTIC';
  const exceptionLevel: GatewayExceptionLevel = gateway.exceptionLevel === 'DEBUG' ? 'DEBUG' : 'NONE';

  let policyEngineConfiguration: GatewayPolicyEngineConfiguration | undefined;
  if (gateway.policyEngineConfiguration) {
    // Extract policy engine name from ARN (last segment after /)
    const arnParts = gateway.policyEngineConfiguration.arn.split('/');
    const policyEngineName = arnParts[arnParts.length - 1] ?? gateway.policyEngineConfiguration.arn;
    policyEngineConfiguration = {
      policyEngineName,
      mode: gateway.policyEngineConfiguration.mode as 'LOG_ONLY' | 'ENFORCE',
    };
  }

  return {
    name: localName,
    resourceName: gateway.name,
    ...(gateway.description && { description: gateway.description }),
    targets,
    authorizerType,
    ...(authorizerConfiguration && { authorizerConfiguration }),
    enableSemanticSearch,
    exceptionLevel,
    ...(policyEngineConfiguration && { policyEngineConfiguration }),
    ...(gateway.roleArn && { executionRoleArn: gateway.roleArn }),
    ...(gateway.tags && Object.keys(gateway.tags).length > 0 && { tags: gateway.tags }),
  };
}

// ============================================================================
// Credential ARN → Name Resolution
// ============================================================================

/**
 * Build a map from credential provider ARN → credential name
 * using the project's deployed state.
 * @internal
 */
export async function buildCredentialArnMap(
  configIO: { readDeployedState: () => Promise<unknown> },
  targetName: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
    const state = (await configIO.readDeployedState()) as any;
    const credentials = state?.targets?.[targetName]?.resources?.credentials;
    if (credentials && typeof credentials === 'object') {
      for (const [name, entry] of Object.entries(credentials)) {
        const arn = (entry as any)?.credentialProviderArn;
        if (typeof arn === 'string') {
          map.set(arn, name);
        }
      }
    }
    /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
  } catch {
    // No deployed state — credentials won't be resolved
  }
  return map;
}

// ============================================================================
// Import Flow
// ============================================================================

/**
 * Handle `agentcore import gateway`.
 */
export async function handleImportGateway(options: ImportResourceOptions): Promise<ImportResourceResult> {
  let configSnapshot: AgentCoreProjectSpec | undefined;
  let configWritten = false;
  let importCtx: Awaited<ReturnType<typeof resolveImportContext>> | undefined;

  const rollback = async () => {
    if (configWritten && configSnapshot && importCtx) {
      try {
        await importCtx.ctx.configIO.writeProjectSpec(configSnapshot);
      } catch (err) {
        console.warn(`Warning: Could not restore agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    // 1-2. Validate project context and resolve target
    importCtx = await resolveImportContext(options, 'import-gateway');
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Fetch gateway from AWS
    logger.startStep('Fetch gateway from AWS');
    let gatewayId: string;

    if (options.arn) {
      gatewayId = parseAndValidateArn(options.arn, 'gateway', target).resourceId;
    } else {
      onProgress('Listing gateways in your account...');
      const summaries = await listAllGateways({ region: target.region });

      if (summaries.length === 0) {
        return failResult(logger, 'No gateways found in your account.', 'gateway', '');
      }

      if (summaries.length === 1) {
        gatewayId = summaries[0]!.gatewayId;
        onProgress(`Found 1 gateway: ${summaries[0]!.name} (${gatewayId}). Auto-selecting.`);
      } else {
        console.log(`\nFound ${summaries.length} gateway(s):\n`);
        for (let i = 0; i < summaries.length; i++) {
          const s = summaries[i]!;
          console.log(
            `  ${ANSI.dim}[${i + 1}]${ANSI.reset} ${s.name} — ${s.status}\n` +
              `       ${ANSI.dim}${s.gatewayId} (${s.authorizerType})${ANSI.reset}`
          );
        }
        console.log('');
        return failResult(
          logger,
          'Multiple gateways found. Use --arn <arn> to specify which gateway to import.',
          'gateway',
          ''
        );
      }
    }

    onProgress(`Fetching gateway details for ${gatewayId}...`);
    let gatewayDetail;
    try {
      gatewayDetail = await getGatewayDetail({ region: target.region, gatewayId });
    } catch (err) {
      if (isAccessDeniedError(err)) {
        return failResult(
          logger,
          `Gateway "${gatewayId}" could not be found in region ${target.region}. ` +
            `AWS returned AccessDenied, which for this service typically means the gateway does not exist, ` +
            `the ARN is malformed, or your credentials lack bedrock-agentcore:GetGateway permission. ` +
            `Verify the ARN with: aws bedrock-agentcore-control list-gateways --region ${target.region}`,
          'gateway',
          options.name ?? ''
        );
      }
      throw err;
    }

    if (gatewayDetail.status !== 'READY') {
      onProgress(`Warning: Gateway status is ${gatewayDetail.status}, not READY`);
    }

    // 3b. Fetch all targets
    onProgress('Listing gateway targets...');
    const targetSummaries = await listAllGatewayTargets({ region: target.region, gatewayId });
    onProgress(`Found ${targetSummaries.length} target(s) for gateway`);

    const targetDetails: GatewayTargetDetail[] = [];
    for (const ts of targetSummaries) {
      const td = await getGatewayTargetDetail({ region: target.region, gatewayId, targetId: ts.targetId });
      targetDetails.push(td);
    }
    logger.endStep('success');

    // 4. Validate name
    logger.startStep('Validate name');
    let localName = options.name ?? gatewayDetail.name;
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        'gateway',
        localName
      );
    }
    onProgress(`Gateway: ${gatewayDetail.name} -> local name: ${localName}`);
    logger.endStep('success');

    // 5. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set(projectSpec.agentCoreGateways.map(g => g.name));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `Gateway "${localName}" already exists in the project. Use --name to specify a different local name.`,
        'gateway',
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'gateway', gatewayId);
    const isReimport = !!existingResource;
    if (existingResource) {
      if (!options.name) {
        localName = existingResource;
      }
      onProgress(`Gateway already managed by CloudFormation — re-adding to project config`);
    }
    logger.endStep('success');

    // 6. Map AWS responses to CLI schema
    logger.startStep('Map gateway to project schema');
    const credentialArnMap = await buildCredentialArnMap(ctx.configIO, targetName);

    const mappedTargets: AgentCoreGatewayTarget[] = [];
    for (const td of targetDetails) {
      const mapped = toGatewayTargetSpec(td, credentialArnMap, onProgress);
      if (mapped) {
        mappedTargets.push(mapped);
      }
    }

    const gatewaySpec = toGatewaySpec(gatewayDetail, mappedTargets, localName);
    onProgress(`Mapped gateway with ${mappedTargets.length} target(s)`);
    if (mappedTargets.length < targetDetails.length) {
      onProgress(
        `Warning: ${targetDetails.length - mappedTargets.length} target(s) could not be mapped and were skipped`
      );
    }
    logger.endStep('success');

    // 7. Update project config
    logger.startStep('Update project config');
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    projectSpec.agentCoreGateways.push(gatewaySpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added gateway "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 8. CDK build -> synth -> bootstrap -> phase 1 -> phase 2 -> update state
    logger.startStep('Build and synth CDK');
    const stackName = toStackName(ctx.projectName, targetName);

    // Build target ID map for CFN import: target name → physical target ID
    const targetIdMap = new Map<string, string>();
    for (const td of targetDetails) {
      const mappedTarget = mappedTargets.find(mt => mt.name === td.name);
      if (mappedTarget) {
        targetIdMap.set(td.name, td.targetId);
      }
    }

    const pipelineResult = await executeCdkImportPipeline({
      projectRoot: ctx.projectRoot,
      stackName,
      target,
      configIO: ctx.configIO,
      targetName,
      onProgress,
      buildResourcesToImport: (synthTemplate, deployedTemplate) => {
        const resourcesToImport: ResourceToImport[] = [];

        // Exclude logical IDs already managed by the stack so we never re-import
        // a previously-imported gateway or target with a colliding Name.
        const deployedIds = new Set(Object.keys(deployedTemplate.Resources));

        // Find gateway logical ID
        const gatewayResourceName = `${ctx.projectName}-${localName}`;
        let gatewayLogicalId = findLogicalIdByProperty(
          synthTemplate,
          'AWS::BedrockAgentCore::Gateway',
          'Name',
          gatewayResourceName,
          { excludeLogicalIds: deployedIds }
        );
        gatewayLogicalId ??= findLogicalIdByProperty(
          synthTemplate,
          'AWS::BedrockAgentCore::Gateway',
          'Name',
          localName,
          { excludeLogicalIds: deployedIds }
        );
        if (!gatewayLogicalId) {
          const candidateGatewayIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Gateway').filter(
            id => !deployedIds.has(id)
          );
          if (candidateGatewayIds.length === 1) {
            gatewayLogicalId = candidateGatewayIds[0];
          }
        }

        if (!gatewayLogicalId) {
          return [];
        }

        resourcesToImport.push({
          resourceType: 'AWS::BedrockAgentCore::Gateway',
          logicalResourceId: gatewayLogicalId,
          resourceIdentifier: { GatewayIdentifier: gatewayId },
        });

        // Find target logical IDs (excluding those already in the deployed stack)
        const candidateTargetIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::GatewayTarget').filter(
          id => !deployedIds.has(id)
        );

        for (const [tName, tId] of targetIdMap) {
          // Try name-based matching first
          let targetLogicalId = findLogicalIdByProperty(
            synthTemplate,
            'AWS::BedrockAgentCore::GatewayTarget',
            'Name',
            tName,
            { excludeLogicalIds: deployedIds }
          );

          // Fall back: if exactly one unmatched target logical ID remains, use it
          if (!targetLogicalId && candidateTargetIds.length === 1 && targetIdMap.size === 1) {
            targetLogicalId = candidateTargetIds[0];
          }

          if (targetLogicalId) {
            resourcesToImport.push({
              resourceType: 'AWS::BedrockAgentCore::GatewayTarget',
              logicalResourceId: targetLogicalId,
              resourceIdentifier: { GatewayIdentifier: gatewayId, TargetId: tId },
            });
          } else {
            onProgress(`Warning: Could not find logical ID for target "${tName}" in CloudFormation template`);
          }
        }

        return resourcesToImport;
      },
      deployedStateEntries: [{ type: 'gateway', name: localName, id: gatewayId, arn: gatewayDetail.gatewayArn }],
    });

    if (pipelineResult.noResources) {
      if (isReimport) {
        logger.endStep('success');
        logger.finalize(true);
        return {
          success: true,
          resourceType: 'gateway',
          resourceName: localName,
          resourceId: gatewayId,
          logPath: logger.getRelativeLogPath(),
        };
      }
      const error = `Could not find logical ID for gateway "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, 'gateway', localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: 'gateway',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 9. Return success
    logger.finalize(true);
    return {
      success: true,
      resourceType: 'gateway',
      resourceName: localName,
      resourceId: gatewayId,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await rollback();
    if (importCtx) {
      importCtx.logger.log(message, 'error');
      importCtx.logger.finalize(false);
    }
    return {
      success: false,
      error: message,
      resourceType: 'gateway',
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
    };
  }
}

/** @internal — exported for unit testing */
export {
  toGatewayTargetSpec as _toGatewayTargetSpec,
  toGatewayTargetSpec,
  resolveOutboundAuth as _resolveOutboundAuth,
};

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register the `import gateway` subcommand.
 */
export function registerImportGateway(importCmd: Command): void {
  importCmd
    .command('gateway')
    .description('Import an existing AgentCore Gateway (with targets) from your AWS account')
    .option('--arn <gatewayArn>', 'Gateway ARN to import')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportGateway(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${ANSI.green}Gateway imported successfully!${ANSI.reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
        console.log(`${ANSI.dim}Next steps:${ANSI.reset}`);
        console.log(`  agentcore deploy     ${ANSI.dim}Deploy the imported stack${ANSI.reset}`);
        console.log(`  agentcore status     ${ANSI.dim}Verify resource status${ANSI.reset}`);
        console.log(`  agentcore fetch access  ${ANSI.dim}Get gateway URL and token${ANSI.reset}`);
        console.log('');
      } else {
        console.error(`\n${ANSI.red}[error]${ANSI.reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
