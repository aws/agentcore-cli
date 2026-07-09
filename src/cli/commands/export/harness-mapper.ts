import { APP_DIR } from '../../../lib';
import { ValidationError } from '../../../lib/errors/types';
import {
  BROWSER_ARN_PATTERN,
  CODE_INTERPRETER_ARN_PATTERN,
  connectionEnvToken,
  connectionIdForTarget,
  resourceIdFromArn,
} from '../../../schema';
import type {
  AgentEnvSpec,
  BuildType,
  Connection,
  ConnectionTarget,
  Credential,
  DirectoryPath,
  FilePath,
  MemoryStrategy,
  MemoryStrategyType,
  ModelProvider,
} from '../../../schema';
import type {
  HarnessGatewayOutboundAuth,
  HarnessSkill,
  HarnessSkillAwsSkillsSource,
  HarnessSkillGitSource,
  HarnessSkillPathSource,
  HarnessSkillS3Source,
  HarnessSpec,
  HarnessToolType,
  HarnessTruncationConfig,
} from '../../../schema/schemas/primitives/harness';
import { arnPrefix, dnsSuffix } from '../../aws/partition';
import { GatewayPrimitive } from '../../primitives/GatewayPrimitive';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';
import type {
  AgentRenderConfig,
  GatewayProviderRenderConfig,
  IdentityProviderRenderConfig,
  MemoryProviderRenderConfig,
} from '../../templates/types';
import { DEFAULT_PYTHON_ENTRYPOINT, DEFAULT_PYTHON_VERSION } from '../../tui/screens/generate/defaults';
import { buildFilesystemConfigurations } from '../shared/filesystem-utils';
import {
  ALLOWED_TOOLS_NOTE_CATEGORY,
  AWS_SKILLS_NOTE_CATEGORY,
  BROWSER_CODZIP_NOTE_CATEGORY,
  CONTAINER_URI_ECR_PULL_NOTE_CATEGORY,
  CONTAINER_URI_NOTE_CATEGORY,
  GATEWAY_GRANT_TYPE_NOTE_CATEGORY,
  GIT_SKILLS_CONTAINER_NOTE_CATEGORY,
  LITELLM_NO_API_KEY_NOTE_CATEGORY,
  MALFORMED_S3_SKILL_NOTE_CATEGORY,
  MALFORMED_TOOL_ARN_NOTE_CATEGORY,
  MCP_HEADER_CREDS_NOTE_CATEGORY,
  PATH_SKILLS_NOTE_CATEGORY,
} from './constants';
import type { ExportNote, HarnessMappingResult, ResolvedHarnessContext } from './types';

// ============================================================================
// Public entry point
// ============================================================================

export function mapHarnessToExportConfig(
  context: ResolvedHarnessContext,
  buildOverride?: BuildType
): HarnessMappingResult {
  const { spec, targetAgentName } = context;

  const buildType = resolveBuildType(spec, buildOverride);

  if (buildType === 'CodeZip' && (spec.containerUri || spec.dockerfile)) {
    const what = spec.containerUri ? `containerUri (${spec.containerUri})` : `dockerfile (${spec.dockerfile})`;
    throw new ValidationError(
      `Harness "${spec.name}" uses ${what}, which requires a Container build. ` + `Re-export with --build Container.`
    );
  }

  const modelProvider = resolveModelProvider(spec.model.provider);
  const allowedToolPatterns = spec.allowedTools ?? ['*'];
  const identityResult = resolveIdentityProvider(spec, context);

  // LiteLLM keyless-but-key-requiring warning. A `bedrock/...` LiteLLM model authenticates via the
  // execution role (no key needed) — the common, valid case. Any other provider prefix (openai/,
  // anthropic/, ...) typically needs an API key; if the harness set no apiKeyArn, the generated
  // client is built keyless and fails at first invocation. Keyless is schema- and runtime-valid,
  // so this is a note, not an error — export is just the right place to flag it.
  if (spec.model.provider === 'lite_llm' && !spec.model.apiKeyArn && !spec.model.modelId.startsWith('bedrock/')) {
    context.exportNotes.push({
      category: LITELLM_NO_API_KEY_NOTE_CATEGORY,
      message:
        `The LiteLLM model "${spec.model.modelId}" is not a Bedrock-backed (bedrock/...) model, but the ` +
        `harness has no apiKeyArn. The exported agent constructs LiteLLMModel without an API key and will ` +
        `fail at first invocation if the provider requires one. Add an API-key credential to the harness ` +
        `(model apiKeyArn), or use a bedrock/ model id (which authenticates via the execution role).`,
    });
  }
  // Bedrock Mantle models are invoked via the bedrock-mantle service (not bedrock:InvokeModel), so
  // the runtime role's default Bedrock grant is insufficient. Generate the bedrock-mantle:CreateInference
  // policy and wire it via additionalPolicies, mirroring the S3-skills opaque-AWS-access pattern.
  resolveBedrockMantlePolicy(spec, context);

  const memoryResult = resolveMemoryProviders(spec, context);
  const gatewayResult = resolveGatewayProviders(spec, context, allowedToolPatterns);
  const hasGateway = gatewayResult.providers.length > 0;
  const toolResult = resolveBrowserCodeInterpreterConnections(spec, allowedToolPatterns, buildType, context);
  const hasExecutionLimits =
    spec.maxIterations !== undefined || spec.maxTokens !== undefined || spec.timeoutSeconds !== undefined;
  const hasSkillsFetcher = spec.skills.length > 0;

  // Static allowedTools filter — record note if not wildcard
  if (!(allowedToolPatterns.length === 1 && allowedToolPatterns[0] === '*')) {
    context.exportNotes.push({
      category: ALLOWED_TOOLS_NOTE_CATEGORY,
      message:
        'The harness allowedTools filter has been applied statically at code-generation time. ' +
        'Tools excluded at export will not be available at runtime, and callers cannot override ' +
        'the tool list per invocation (unlike the harness).',
    });
  }

  // Path skills note
  const pathSkills = spec.skills.filter(s => isPathSkill(s));
  if (pathSkills.length > 0 && buildType === 'CodeZip') {
    context.exportNotes.push({
      category: PATH_SKILLS_NOTE_CATEGORY,
      message:
        `The following skill paths must exist on the container filesystem at runtime: ${pathSkills.map(s => s.path).join(', ')}. ` +
        'For CodeZip builds, path skills are not supported — switch to a Container build and COPY the ' +
        'skill directory in your Dockerfile, or use s3/git skill variants.',
    });
  }

  // git skills + Container: warn that git must be in the image
  const gitSkills = spec.skills.filter(s => isGitSkill(s));
  if (gitSkills.length > 0 && buildType === 'Container') {
    context.exportNotes.push({
      category: GIT_SKILLS_CONTAINER_NOTE_CATEGORY,
      message:
        'The agent clones git skill repositories at runtime using `git`. The default Container base image ' +
        '(`python:3.12-slim`) does not include git. Add it to your Dockerfile before deploying:\n\n' +
        '  RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
    });
  }

  // s3 skills: the agent fetches skill files with boto3 at runtime, so the runtime
  // execution role needs S3 read access. The managed harness fetched these service-side
  // and never granted the customer role S3 permissions, so without this the exported
  // agent fails at first invocation with an opaque S3 AccessDenied. Independent of build type.
  const s3Skills = spec.skills.filter(isS3Skill);
  if (s3Skills.length > 0) {
    // Parse each URI ONCE, partitioning into resolvable ARNs vs malformed URIs. (A second parse pass
    // would be wasted work and risks the two passes ever classifying a URI differently.)
    const malformedUris: string[] = [];
    const arns: NonNullable<ReturnType<typeof parseS3SkillArns>>[] = [];
    for (const { s3Uri } of s3Skills) {
      const parsed = parseS3SkillArns(s3Uri, context.region);
      if (parsed) arns.push(parsed);
      else malformedUris.push(s3Uri);
    }
    // Warn on malformed URIs instead of silently shipping a skills fetcher with no matching S3 IAM
    // (which would fail at runtime with an opaque AccessDenied).
    if (malformedUris.length > 0) {
      context.exportNotes.push({
        category: MALFORMED_S3_SKILL_NOTE_CATEGORY,
        message:
          `These S3 skill URIs could not be parsed into a bucket, so no S3 read permission was ` +
          `generated for them: ${malformedUris.map(u => `"${u}"`).join(', ')}. The exported agent ` +
          `still attempts to fetch these skills at runtime and will fail with S3 AccessDenied. Fix the ` +
          `s3Uri values (expected \`s3://<bucket>/<prefix>\`) on this agent's skills in ` +
          `agentcore/agentcore.json and re-deploy.`,
      });
    }
    if (arns.length > 0) {
      const objectResources = [...new Set(arns.map(a => a.objectArn))];
      const bucketResources = [...new Set(arns.map(a => a.bucketArn))];
      // Generate an inline IAM policy file (opaque AWS access — not a typed connection) and wire it
      // via AgentEnvSpec.additionalPolicies. The CDK attaches it to the runtime role at deploy.
      const policyDoc = {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:GetObject', Resource: objectResources },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketResources },
        ],
      };
      const policyFile = 's3-skills-policy.json';
      context.generatedPolicyFiles[policyFile] = policyDoc;
      if (!context.additionalPolicies.includes(policyFile)) context.additionalPolicies.push(policyFile);
    }
  }

  // AWS skills: managed-only feature, cannot export
  const awsSkills = spec.skills.filter(s => isAwsSkill(s));
  if (awsSkills.length > 0) {
    const patterns = awsSkills.map(s => s.awsSkills.paths?.join(', ') ?? 'all').join('; ');
    context.exportNotes.push({
      category: AWS_SKILLS_NOTE_CATEGORY,
      message:
        `AWS skills are a managed harness feature and are not available in standalone Strands agents. ` +
        `The following skill patterns have been omitted: ${patterns}. ` +
        `You can copy the equivalent skills from https://github.com/aws/agent-toolkit-for-aws/tree/main/skills ` +
        `into your project and load them as path or git skills instead.`,
    });
  }

  // containerUri note
  if (spec.containerUri) {
    context.exportNotes.push({
      category: CONTAINER_URI_NOTE_CATEGORY,
      message:
        `The harness used a pre-built container image as its execution environment (${spec.containerUri}). ` +
        'The generated Dockerfile extends that image directly (FROM <containerUri>) and layers the Strands ' +
        'agent code on top. If your base image does not include Python 3.12+ or uv, add an install step ' +
        'before the `uv sync` steps.',
    });

    // If the base image is a private ECR repository, CodeBuild needs pull access to it.
    const baseImageEcrArn = ecrArnFromUri(spec.containerUri, context.region);
    if (baseImageEcrArn) {
      context.exportNotes.push({
        category: CONTAINER_URI_ECR_PULL_NOTE_CATEGORY,
        message:
          `The base image (${spec.containerUri}) is a private ECR repository. The CodeBuild project that ` +
          `builds this agent's container is not automatically granted permission to pull it.\n\n` +
          `Add the following to agentcore/cdk/lib/cdk-stack.ts after \`this.application\` is created:\n\n` +
          `  import * as ecr from 'aws-cdk-lib/aws-ecr';\n` +
          `  import { ContainerBuildProject } from '@aws/agentcore-cdk';\n\n` +
          `  const baseRepo = ecr.Repository.fromRepositoryArn(this, 'BaseImageEcrRepository', '${baseImageEcrArn}');\n` +
          `  baseRepo.grantPull(ContainerBuildProject.getOrCreate(this).role);`,
      });
    }
  }

  const mcpResolution = resolveRemoteMcpTools(spec, allowedToolPatterns, context);

  const renderConfig: AgentRenderConfig = {
    name: targetAgentName,
    sdkFramework: 'Strands',
    targetLanguage: 'Python',
    modelProvider,
    hasMemory: memoryResult.providers.length > 0,
    hasIdentity: identityResult.provider !== null,
    hasGateway,
    isVpc: spec.networkMode === 'VPC',
    buildType,
    memoryProviders: memoryResult.providers,
    identityProviders: identityResult.provider ? [identityResult.provider] : [],
    gatewayProviders: gatewayResult.providers,
    gatewayAuthTypes: [...new Set(gatewayResult.providers.map(g => g.authType))],
    protocol: 'HTTP',
    dockerfile: resolveDockerfileName(spec, buildType),
    enableOtel: true,
    hasConfigBundle: false,
    hasPayment: false,
    // Execution limits — consumed by execution-limits capability template
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens,
    timeoutSeconds: spec.timeoutSeconds,
    // Truncation — consumed by main.py template
    truncationStrategy: spec.truncation?.strategy,
    truncationConfig: resolveTruncationConfig(spec.truncation),
    // Remote MCP tools — consumed by mcp_client template
    remoteMcpTools: mcpResolution.tools,
    // Filesystem mounts (session storage, EFS, S3) — consumed by main.py/CDK templates
    ...buildFilesystemRenderConfig(spec),
    // Skills (path/s3/git) — consumed by main.py + skills/fetcher.py templates
    ...buildSkillsRenderConfig(spec, hasSkillsFetcher),
    // Inline + builtin + browser/code-interpreter tools (after allowedTools filter)
    ...buildToolsRenderConfig(spec, allowedToolPatterns, toolResult),
    hasExecutionLimits,
    isExportHarness: true,
    modelId: spec.model.modelId,
    // Max output tokens, threaded into load.py for both ordinary Converse Bedrock models
    // (BedrockModel max_tokens) and Mantle models (max_output_tokens/max_completion_tokens).
    modelMaxTokens: spec.model.maxTokens,
    // LiteLLM-only model config (apiBase + additionalParams), threaded into load.py. The model
    // schema is a flat object, so apiBase/additionalParams are always typed-present — only the
    // provider check + a truthiness check are needed.
    ...(spec.model.provider === 'lite_llm' && spec.model.apiBase ? { litellmApiBase: spec.model.apiBase } : {}),
    ...(spec.model.provider === 'lite_llm' &&
    spec.model.additionalParams &&
    Object.keys(spec.model.additionalParams).length > 0
      ? { litellmAdditionalParams: spec.model.additionalParams }
      : {}),
    // Bedrock Mantle (OpenAI-compatible Bedrock models served via the Mantle endpoint, not Converse).
    // Empty for ordinary Converse Bedrock models and all other providers.
    ...buildBedrockMantleRenderConfig(spec),
    // System prompt (written verbatim into main.py)
    systemPromptText: context.systemPrompt,
    actorId: spec.memory?.mode === 'existing' ? spec.memory.actorId : undefined,
  };

  const connections = [
    ...(memoryResult.connections ?? []),
    ...(gatewayResult.connections ?? []),
    ...toolResult.connections,
  ];
  const agentEnvSpec = buildAgentEnvSpec(context, targetAgentName, buildType, connections);

  // Private git skills reference an API-key credential provider for clone auth. Persist a name-only
  // credential entry per distinct provider so the deployed agent's role is granted GetResourceApiKey
  // (via wireCredentialsToAgents → grantCredentialAccess). The provider itself already exists in
  // AgentCore Identity (created out-of-band or in the source project); export only references it.
  const gitCredentialEntries: Credential[] = [];
  const seenGitCred = new Set<string>();
  for (const skill of spec.skills) {
    if (!isGitSkill(skill) || !skill.auth?.credentialName) continue;
    const credName = resourceIdFromArn(skill.auth.credentialName); // bare name or last ARN segment
    if (seenGitCred.has(credName)) continue;
    seenGitCred.add(credName);
    gitCredentialEntries.push({ authorizerType: 'ApiKeyCredentialProvider', name: credName });
  }

  return {
    renderConfig,
    agentEnvSpec,
    credentialEntry: identityResult.credentialEntry,
    mcpCredentialEntries: mcpResolution.credentialEntries,
    gitCredentialEntries,
  };
}

// ============================================================================
// RenderConfig sub-builders
// ============================================================================

/** Filesystem mounts (session storage, EFS, S3) consumed by main.py and CDK templates. */
function buildFilesystemRenderConfig(
  spec: HarnessSpec
): Pick<AgentRenderConfig, 'sessionStorageMountPath' | 'efsMounts' | 's3Mounts' | 'needsOs'> {
  const efsMounts = (spec.efsAccessPoints ?? []).map(ap => ({
    accessPointArn: ap.accessPointArn,
    mountPath: ap.mountPath,
  }));
  const s3Mounts = (spec.s3AccessPoints ?? []).map(ap => ({
    accessPointArn: ap.accessPointArn,
    mountPath: ap.mountPath,
  }));
  return {
    sessionStorageMountPath: spec.sessionStoragePath,
    efsMounts,
    s3Mounts,
    needsOs: !!spec.sessionStoragePath || efsMounts.length > 0 || s3Mounts.length > 0,
  };
}

/** Path/S3/git skills consumed by main.py and skills/fetcher.py templates. */
function buildSkillsRenderConfig(
  spec: HarnessSpec,
  hasSkillsFetcher: boolean
): Pick<AgentRenderConfig, 'pathSkills' | 's3Skills' | 'gitSkills' | 'hasSkillsFetcher' | 'hasFetchedSkills'> {
  return {
    pathSkills: spec.skills.filter(isPathSkill).map(s => s.path),
    s3Skills: spec.skills.filter(isS3Skill).map(s => s.s3Uri),
    gitSkills: spec.skills.filter(isGitSkill).map(s => ({
      url: s.gitUrl,
      path: s.path,
      credentialArn: s.auth?.credentialName,
      username: s.auth?.username,
    })),
    hasSkillsFetcher,
    hasFetchedSkills: spec.skills.some(s => isS3Skill(s) || isGitSkill(s)),
  };
}

/**
 * Inline + builtin tools (after allowedTools filter), plus the browser/code-interpreter render
 * fields lifted straight from the already-resolved BrowserCodeInterpreterResult — the single source
 * for those values, so the identifier env var here always matches the connection that injects it.
 */
function buildToolsRenderConfig(
  spec: HarnessSpec,
  allowedToolPatterns: string[],
  toolResult: BrowserCodeInterpreterResult
): Pick<
  AgentRenderConfig,
  | 'inlineFunctionTools'
  | 'hasBrowser'
  | 'browserIdentifierEnvVar'
  | 'hasCodeInterpreter'
  | 'codeInterpreterIdentifierEnvVar'
  | 'hasShell'
  | 'hasFileOperations'
> {
  return {
    inlineFunctionTools: resolveInlineFunctionTools(spec, allowedToolPatterns),
    hasBrowser: toolResult.hasBrowser,
    browserIdentifierEnvVar: toolResult.browserIdentifierEnvVar,
    hasCodeInterpreter: toolResult.hasCodeInterpreter,
    codeInterpreterIdentifierEnvVar: toolResult.codeInterpreterIdentifierEnvVar,
    // Builtin tools — always available in the Harness runtime, included unless filtered out by allowedTools
    hasShell: isBuiltinIncluded('shell', allowedToolPatterns),
    hasFileOperations: isBuiltinIncluded('file_operations', allowedToolPatterns),
  };
}

// ============================================================================
// AgentEnvSpec builder
// ============================================================================

function buildAgentEnvSpec(
  context: ResolvedHarnessContext,
  targetAgentName: string,
  buildType: BuildType,
  connections: Connection[] = []
): AgentEnvSpec {
  const { spec } = context;
  const codeLocation = `${APP_DIR}/${targetAgentName}/` as DirectoryPath;

  const envVars = Object.entries(spec.environmentVariables ?? {}).map(([name, value]) => ({ name, value }));

  return {
    name: targetAgentName,
    build: buildType,
    ...(resolveDockerfileName(spec, buildType) && { dockerfile: resolveDockerfileName(spec, buildType)! as FilePath }),
    entrypoint: DEFAULT_PYTHON_ENTRYPOINT as FilePath,
    codeLocation,
    runtimeVersion: DEFAULT_PYTHON_VERSION,
    networkMode: spec.networkMode ?? 'PUBLIC',
    protocol: 'HTTP',
    ...(spec.networkMode === 'VPC' && spec.networkConfig && { networkConfig: spec.networkConfig }),
    ...(spec.authorizerType && { authorizerType: spec.authorizerType }),
    ...(spec.authorizerConfiguration && { authorizerConfiguration: spec.authorizerConfiguration }),
    ...(spec.lifecycleConfig && {
      lifecycleConfiguration: {
        ...(spec.lifecycleConfig.idleRuntimeSessionTimeout !== undefined && {
          idleRuntimeSessionTimeout: spec.lifecycleConfig.idleRuntimeSessionTimeout,
        }),
        ...(spec.lifecycleConfig.maxLifetime !== undefined && {
          maxLifetime: spec.lifecycleConfig.maxLifetime,
        }),
      },
    }),
    ...(spec.executionRoleArn && { executionRoleArn: spec.executionRoleArn }),
    ...(envVars.length > 0 && { envVars }),
    ...(connections.length > 0 && { connections }),
    ...(context.additionalPolicies.length > 0 && { additionalPolicies: context.additionalPolicies }),
    ...(spec.tags && { tags: spec.tags }),
    ...buildFilesystemConfigurations(spec.sessionStoragePath, spec.efsAccessPoints, spec.s3AccessPoints),
  };
}

// ============================================================================
// Connection helpers (external resources)
// ============================================================================

/**
 * Stable connection id for an external target, by kind + arn. Thin adapter over the schema's
 * canonical `connectionIdForTarget` (the single source of truth shared with the CDK) — kept because
 * the call sites here have a kind+arn rather than a built target object.
 */
function externalConnectionId(
  kind: 'memory' | 'gateway' | 'runtime' | 'browser' | 'codeInterpreter',
  arn: string
): string {
  return connectionIdForTarget({ type: kind, arn } as ConnectionTarget);
}

/**
 * Discovery env-var name `<PREFIX>_<TOKEN>_<SUFFIX>` from a connection id. The token derivation is
 * the schema's canonical `connectionEnvToken` — the single source of truth the CDK wiring also uses,
 * so the name baked into generated code always matches what deploy injects.
 */
function connectionEnvVarName(prefix: string, connectionId: string, suffix: string): string {
  return `${prefix}_${connectionEnvToken(connectionId)}_${suffix}`;
}

/**
 * Map a harness gateway outboundAuth onto the connection's GatewayOutboundAuth. The shapes match
 * except for the oauth grant-type enum: the harness uses CLIENT_CREDENTIALS | USER_FEDERATION,
 * while the connection (matching the runtime/Smithy model) uses CLIENT_CREDENTIALS |
 * AUTHORIZATION_CODE | TOKEN_EXCHANGE. USER_FEDERATION maps to AUTHORIZATION_CODE.
 */
function toConnectionGatewayAuth(
  outboundAuth: HarnessGatewayOutboundAuth | undefined
): Extract<ConnectionTarget, { type: 'gateway' }>['outboundAuth'] {
  if (!outboundAuth) return undefined;
  if ('awsIam' in outboundAuth) return { awsIam: {} };
  if ('none' in outboundAuth) return { none: {} };
  const { providerArn, scopes, grantType, customParameters } = outboundAuth.oauth;
  const mappedGrant =
    grantType === 'USER_FEDERATION'
      ? 'AUTHORIZATION_CODE'
      : grantType === 'CLIENT_CREDENTIALS'
        ? 'CLIENT_CREDENTIALS'
        : undefined;
  return {
    oauth: {
      providerArn,
      scopes,
      ...(mappedGrant && { grantType: mappedGrant }),
      ...(customParameters && { customParameters }),
    },
  };
}

/**
 * Map a HARNESS OAuth grant type to the AgentCore Identity auth flow consumed by the generated
 * client's `@requires_access_token(auth_flow=...)`. The harness enum is CLIENT_CREDENTIALS |
 * USER_FEDERATION (see HarnessGatewayOutboundAuth); both have a decorator equivalent:
 *   CLIENT_CREDENTIALS -> M2M, USER_FEDERATION -> USER_FEDERATION.
 * The SDK decorator's auth_flow is `Literal["M2M","USER_FEDERATION"]`. Unset grant defaults to M2M.
 * Returns undefined only for an unrecognized value (caller emits a manual-step note).
 */
function grantTypeToAuthFlow(grantType: string | undefined): string | undefined {
  switch (grantType) {
    case undefined:
    case 'CLIENT_CREDENTIALS':
      return 'M2M';
    case 'USER_FEDERATION':
      return 'USER_FEDERATION';
    default:
      return undefined; // unrecognized — not expressible via the decorator
  }
}

// ============================================================================
// Model provider
// ============================================================================

function resolveModelProvider(provider: 'bedrock' | 'open_ai' | 'gemini' | 'lite_llm'): ModelProvider {
  switch (provider) {
    case 'bedrock':
      return 'Bedrock';
    case 'open_ai':
      return 'OpenAI';
    case 'gemini':
      return 'Gemini';
    case 'lite_llm':
      return 'LiteLLM';
  }
}

/**
 * Proprietary OpenAI models (e.g. openai.gpt-5.4, openai.gpt-5.5) are served on the Bedrock Mantle
 * `/openai/v1` path; open-source OpenAI models (openai.gpt-oss-*) use `/v1`.
 */
function isProprietaryOpenAiModel(modelId: string): boolean {
  return modelId.startsWith('openai.') && !modelId.includes('gpt-oss');
}

/**
 * Bedrock Mantle render config. A Bedrock model whose apiFormat is `responses`/`chat_completions`
 * (not `converse_stream`) is an OpenAI-compatible model served via the Bedrock Mantle endpoint, NOT
 * the Converse API — building a plain BedrockModel for it makes invocation fail with
 * "The provided model identifier is invalid" on ConverseStream. When that combination is detected,
 * emit the fields load.py needs to construct the OpenAI-style Mantle client (base URL is derived at
 * runtime from AWS_REGION). Returns {} for ordinary Converse Bedrock models.
 */
function buildBedrockMantleRenderConfig(spec: HarnessSpec): Partial<AgentRenderConfig> {
  if (!isBedrockMantleModel(spec)) return {};
  const apiFormat = spec.model.apiFormat as 'responses' | 'chat_completions';
  return {
    bedrockMantle: true,
    mantleApiFormat: apiFormat,
    mantleProprietary: isProprietaryOpenAiModel(spec.model.modelId),
    modelTemperature: spec.model.temperature,
    modelTopP: spec.model.topP,
  };
}

/** A Bedrock model whose apiFormat routes it through the OpenAI-compatible Mantle endpoint. */
function isBedrockMantleModel(spec: HarnessSpec): boolean {
  return (
    spec.model.provider === 'bedrock' &&
    (spec.model.apiFormat === 'responses' || spec.model.apiFormat === 'chat_completions')
  );
}

/**
 * Bedrock Mantle invocation goes through the `bedrock-mantle` service (CreateInference), NOT
 * `bedrock:InvokeModel`, so the runtime role's default Bedrock grant does not cover it. Emit an
 * inline IAM policy (opaque AWS access, like S3 skills) granting bedrock-mantle:CreateInference on
 * the account's default Mantle project, wired via AgentEnvSpec.additionalPolicies.
 */
function resolveBedrockMantlePolicy(spec: HarnessSpec, context: ResolvedHarnessContext): void {
  if (!isBedrockMantleModel(spec)) return;
  // arnPrefix returns `arn:<partition>` (e.g. arn:aws); region defaults to us-east-1 only to pick the
  // partition — the ARN itself wildcards region/account so the runtime works wherever it deploys.
  const prefix = arnPrefix(context.region ?? 'us-east-1');
  const policyDoc = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'bedrock-mantle:CreateInference',
        // The Mantle endpoint resolves the caller's account; access is scoped to the default project.
        Resource: `${prefix}:bedrock-mantle:*:*:project/default`,
      },
      {
        // The bearer-token auth path (provide_token -> Mantle) requires CallWithBearerToken, which
        // the service authorizes against resource `*` (it is not resource-scoped).
        Effect: 'Allow',
        Action: 'bedrock-mantle:CallWithBearerToken',
        Resource: '*',
      },
    ],
  };
  const policyFile = 'bedrock-mantle-policy.json';
  context.generatedPolicyFiles[policyFile] = policyDoc;
  if (!context.additionalPolicies.includes(policyFile)) context.additionalPolicies.push(policyFile);
}

// ============================================================================
// Identity provider (non-Bedrock model credential)
// ============================================================================

interface IdentityResult {
  provider: IdentityProviderRenderConfig | null;
  credentialEntry: Credential | null;
}

function resolveIdentityProvider(spec: HarnessSpec, context: ResolvedHarnessContext): IdentityResult {
  if (spec.model.provider === 'bedrock') {
    return { provider: null, credentialEntry: null };
  }

  const apiKeyArn = spec.model.apiKeyArn;
  if (!apiKeyArn) {
    return { provider: null, credentialEntry: null };
  }

  // Try to find an existing credential in the project that matches the ARN
  const existing = context.projectSpec.credentials.find(c => {
    if ('apiKeyArn' in c) return (c as { apiKeyArn?: string }).apiKeyArn === apiKeyArn;
    if ('credentialProviderArn' in c)
      return (c as { credentialProviderArn?: string }).credentialProviderArn === apiKeyArn;
    return false;
  });

  if (existing) {
    return {
      provider: { name: existing.name, envVarName: computeDefaultCredentialEnvVarName(existing.name) },
      credentialEntry: null, // already in project
    };
  }

  // Extract the credential provider name from a token-vault ARN if possible, otherwise
  // synthesize one from the project name + provider. This ensures the deployed credential
  // entry references the same provider that was used in the harness.
  // ARN format: arn:aws:bedrock-agentcore:<region>:<account>:token-vault/<vault>/apikeycredentialprovider/<name>
  const arnNameMatch = /\/apikeycredentialprovider\/([^/]+)$/.exec(apiKeyArn);
  const credentialName = arnNameMatch
    ? arnNameMatch[1]!
    : `${context.projectSpec.name}${resolveModelProvider(spec.model.provider)}`;
  const credentialEntry: Credential = {
    authorizerType: 'ApiKeyCredentialProvider',
    name: credentialName,
  };

  return {
    provider: { name: credentialName, envVarName: computeDefaultCredentialEnvVarName(credentialName) },
    credentialEntry,
  };
}

// ============================================================================
// Memory providers
// ============================================================================

interface MemoryResult {
  providers: MemoryProviderRenderConfig[];
  /** Connections to external memories (IAM + env wiring generated at deploy). */
  connections?: Connection[];
}

function resolveMemoryProviders(spec: HarnessSpec, context: ResolvedHarnessContext): MemoryResult {
  // Only an `existing` reference resolves a concrete memory to wire as an env var. Managed memory's
  // ARN is service-populated at deploy time (nothing to resolve at export); disabled has none.
  if (spec.memory?.mode !== 'existing') return { providers: [] };

  const { name: memName, arn: memArn } = spec.memory;

  if (memName) {
    // Same-project memory by name
    const memEntry = context.projectSpec.memories?.find(m => m.name === memName);
    const strategies: MemoryStrategyType[] = (memEntry?.strategies ?? []).map((s: MemoryStrategy) => s.type);
    const envVarName = `MEMORY_${memName.toUpperCase()}_ID`;
    return {
      providers: [{ name: memName, envVarName, strategies }],
    };
  }

  if (memArn) {
    // Try to cross-reference against deployed state
    const deployedMemories = context.deployedResources?.memories ?? {};
    const match = Object.entries(deployedMemories).find(([, state]) => state.memoryArn === memArn);
    if (match) {
      const [resolvedName] = match;
      const memEntry = context.projectSpec.memories?.find(m => m.name === resolvedName);
      const strategies: MemoryStrategyType[] = (memEntry?.strategies ?? []).map((s: MemoryStrategy) => s.type);
      const envVarName = `MEMORY_${resolvedName.toUpperCase()}_ID`;
      return {
        providers: [{ name: resolvedName, envVarName, strategies }],
      };
    }

    // External memory — model as a connection. The CDK generates the correct IAM (the full
    // memory action set scoped to the ARN) and injects the discovery env var at deploy. The
    // env var name MUST match what the connection wiring injects (MEMORY_<TOKEN>_ID).
    // access: 'readwrite' — the agent both reads conversation history and writes events
    // (CreateEvent) to memory at runtime, so read-only would fail with AccessDenied on writes.
    const connectionId = externalConnectionId('memory', memArn);
    const envVarName = connectionEnvVarName('MEMORY', connectionId, 'ID');
    // Write the discovery value to .env.local for local dev (`agentcore dev`), mirroring the
    // gateway/browser/code-interpreter branches. At deploy the CDK connection wiring injects the
    // same MEMORY_<TOKEN>_ID = resourceIdFromArn(arn); without this, the var is unset locally and
    // session.py silently disables memory (get_memory_session_manager returns None).
    context.localEnvVars[envVarName] = resourceIdFromArn(memArn);
    return {
      providers: [{ name: connectionId, envVarName, strategies: [] }],
      connections: [{ id: connectionId, to: { type: 'memory', arn: memArn }, access: 'readwrite' }],
    };
  }

  return { providers: [] };
}

// ============================================================================
// Gateway providers
// ============================================================================

interface GatewayResult {
  providers: GatewayProviderRenderConfig[];
  /** Connections to external gateways (IAM generated at deploy from outboundAuth). */
  connections?: Connection[];
}

function resolveGatewayProviders(
  spec: HarnessSpec,
  context: ResolvedHarnessContext,
  allowedToolPatterns: string[]
): GatewayResult {
  const providers: GatewayProviderRenderConfig[] = [];
  const connections: Connection[] = [];

  for (const tool of spec.tools) {
    if (tool.type !== 'agentcore_gateway') continue;
    if (!tool.config || !('agentCoreGateway' in tool.config)) continue;
    if (!matchesAllowedTools(tool.name, allowedToolPatterns)) continue;

    const gwConfig = (
      tool.config as { agentCoreGateway: { gatewayArn: string; outboundAuth?: HarnessGatewayOutboundAuth } }
    ).agentCoreGateway;
    const gatewayArn = gwConfig.gatewayArn;

    // Try to find in deployed state (same-project gateway)
    const deployedGateways = context.deployedResources?.mcp?.gateways ?? {};
    const deployedMatch = Object.entries(deployedGateways).find(([, state]) => state.gatewayArn === gatewayArn);

    if (deployedMatch) {
      const [gatewayName] = deployedMatch;
      const projectGateway = context.projectSpec.agentCoreGateways?.find(g => g.name === gatewayName);
      const authType = projectGateway?.authorizerType ?? 'AWS_IAM';

      const provider: GatewayProviderRenderConfig = {
        name: gatewayName,
        envVarName: GatewayPrimitive.computeDefaultGatewayEnvVarName(gatewayName),
        authType,
      };

      if (authType === 'CUSTOM_JWT' && projectGateway?.authorizerConfiguration?.customJwtAuthorizer) {
        const jwtConfig = projectGateway.authorizerConfiguration.customJwtAuthorizer;
        provider.discoveryUrl = jwtConfig.discoveryUrl;
        provider.credentialProviderName = computeManagedOAuthCredentialName(gatewayName);
        const scopes =
          'allowedScopes' in jwtConfig ? (jwtConfig as { allowedScopes?: string[] }).allowedScopes : undefined;
        if (scopes?.length) {
          provider.scopes = scopes.join(' ');
        }
      }

      providers.push(provider);
      // Same-project gateway: AgentCoreMcp.wireGatewayUrlsToAgents() auto-grants InvokeGateway
      // to all runtime environments — no manual IAM step needed.
    } else {
      // External gateway — model as a connection. The CDK generates the correct IAM
      // (InvokeGateway for awsIam, token-fetch for oauth) AND injects the discovery env vars
      // (GATEWAY_<id>_URL derived from the ARN, AUTH_TYPE, credential provider) at deploy, so the
      // generated client reads the URL from the env var rather than a hardcoded literal.
      const outboundAuth = gwConfig.outboundAuth;
      const authType = outboundAuth
        ? 'oauth' in outboundAuth
          ? 'CUSTOM_JWT'
          : 'awsIam' in outboundAuth
            ? 'AWS_IAM'
            : 'NONE'
        : 'AWS_IAM';

      const connectionId = externalConnectionId('gateway', gatewayArn);
      connections.push({
        id: connectionId,
        to: { type: 'gateway', arn: gatewayArn, outboundAuth: toConnectionGatewayAuth(outboundAuth) },
      });

      // The env var the connection wiring injects (GATEWAY_<token>_URL) — the generated client
      // reads it via os.environ.get. Also written to .env.local for local dev (static, from ARN).
      const urlEnvVar = connectionEnvVarName('GATEWAY', connectionId, 'URL');
      context.localEnvVars[urlEnvVar] = deriveGatewayUrl(gatewayArn);

      const provider: GatewayProviderRenderConfig = {
        name: tool.name,
        envVarName: urlEnvVar,
        authType,
      };

      if (authType === 'CUSTOM_JWT' && outboundAuth && 'oauth' in outboundAuth) {
        // The credential provider name the generated client passes to @requires_access_token MUST
        // be the real provider behind the ARN (the harness already created it) — derive it from the
        // providerArn, not a name synthesized from the tool.
        provider.credentialProviderName = resourceIdFromArn(outboundAuth.oauth.providerArn);
        const scopes = outboundAuth.oauth.scopes;
        if (scopes?.length) {
          provider.scopes = scopes.join(' ');
        }
        // Thread the grant type through to the generated client's auth_flow, so a
        // USER_FEDERATION harness gateway exports a USER_FEDERATION client instead of a hardcoded M2M.
        const authFlow = grantTypeToAuthFlow(outboundAuth.oauth.grantType);
        if (authFlow) provider.authFlow = authFlow;
        if (outboundAuth.oauth.customParameters && Object.keys(outboundAuth.oauth.customParameters).length > 0) {
          provider.customParameters = outboundAuth.oauth.customParameters;
        }
        // Only TOKEN_EXCHANGE has no @requires_access_token equivalent (auth_flow is
        // Literal["M2M","USER_FEDERATION"]) — surface that as the one remaining manual case.
        if (!authFlow) {
          context.exportNotes.push({
            category: GATEWAY_GRANT_TYPE_NOTE_CATEGORY,
            message:
              `Gateway tool "${tool.name}" uses OAuth grant type "${outboundAuth.oauth.grantType}", which the ` +
              `generated MCP client cannot express (the AgentCore Identity decorator supports only M2M and ` +
              `USER_FEDERATION flows). Update mcp_client/client.py to perform the token exchange manually, or ` +
              `reconfigure the gateway to use CLIENT_CREDENTIALS or AUTHORIZATION_CODE.`,
          });
        }
      }

      providers.push(provider);
    }
  }

  return { providers, connections };
}

// ============================================================================
// Inline function tools
// ============================================================================

interface InlineFunctionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function resolveInlineFunctionTools(spec: HarnessSpec, allowedPatterns: string[]): InlineFunctionTool[] {
  return spec.tools
    .filter(t => t.type === 'inline_function')
    .filter(t => matchesAllowedTools(t.name, allowedPatterns))
    .map(t => {
      const cfg = (t.config as { inlineFunction: { description: string; inputSchema: Record<string, unknown> } })
        .inlineFunction;
      return { name: t.name, description: cfg.description, inputSchema: cfg.inputSchema };
    });
}

// ============================================================================
// Remote MCP tools
// ============================================================================

interface RemoteMcpTool {
  name: string;
  url: string;
  headerCredentials?: { headerKey: string; credentialName: string; envVarName: string }[];
}

interface McpCredentialEntry {
  credential: Credential;
  envVarName: string;
  value: string;
}

interface RemoteMcpResolution {
  tools: RemoteMcpTool[];
  credentialEntries: McpCredentialEntry[];
}

function resolveRemoteMcpTools(
  spec: HarnessSpec,
  allowedPatterns: string[],
  context: ResolvedHarnessContext
): RemoteMcpResolution {
  const tools: RemoteMcpTool[] = [];
  const credentialEntries: McpCredentialEntry[] = [];

  for (const tool of spec.tools) {
    if (tool.type !== 'remote_mcp') continue;
    if (!matchesAllowedTools(tool.name, allowedPatterns)) continue;
    if (!tool.config || !('remoteMcp' in tool.config)) continue;

    const cfg = (tool.config as { remoteMcp: { url: string; headers?: Record<string, string> } }).remoteMcp;
    const headerKeys = Object.keys(cfg.headers ?? {});

    let headerCredentials: RemoteMcpTool['headerCredentials'];
    if (headerKeys.length > 0) {
      headerCredentials = [];
      const toolPrefix = tool.name.replace(/[^A-Za-z0-9]/g, '');
      for (const hdr of headerKeys) {
        const credName = `${context.projectSpec.name}Mcp${toolPrefix}${hdr.replace(/[^A-Za-z0-9]/g, '')}`;
        const envVarName = computeDefaultCredentialEnvVarName(credName);
        headerCredentials.push({ headerKey: hdr, credentialName: credName, envVarName });
        credentialEntries.push({
          credential: { authorizerType: 'ApiKeyCredentialProvider', name: credName },
          envVarName,
          value: cfg.headers![hdr] ?? '',
        });
      }
      context.exportNotes.push({
        category: MCP_HEADER_CREDS_NOTE_CATEGORY,
        message:
          `MCP tool "${tool.name}" has request headers managed via AgentCore Identity. ` +
          `Credential entries added to agentcore.json; values written to agentcore/.env.local. ` +
          `Credentials are provisioned automatically on \`agentcore deploy\`.\n\n` +
          headerCredentials.map(h => `  ${h.credentialName}  (env var: ${h.envVarName})`).join('\n'),
      });
    }

    tools.push({ name: tool.name, url: cfg.url, headerCredentials });
  }

  return { tools, credentialEntries };
}

// ============================================================================
// Helpers
// ============================================================================

function resolveBuildType(spec: HarnessSpec, override?: BuildType): BuildType {
  if (override) return override;
  if (spec.containerUri || spec.dockerfile) return 'Container';
  return 'CodeZip';
}

function resolveDockerfileName(spec: HarnessSpec, buildType: BuildType): string | undefined {
  if (buildType !== 'Container') return undefined;
  if (spec.dockerfile) return spec.dockerfile;
  if (spec.containerUri) return 'Dockerfile'; // we generate it
  return undefined;
}

function deriveGatewayUrl(gatewayArn: string): string {
  // arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/abc123
  const parts = gatewayArn.split(':');
  const region = parts[3] ?? 'us-east-1';
  const resourcePart = parts[parts.length - 1] ?? '';
  const gatewayId = resourcePart.replace('gateway/', '');
  return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix(region)}/mcp`;
}

/**
 * Extract the ECR repository ARN from an ECR image URI.
 * Returns undefined if the URI is not an ECR private registry URI.
 *
 * Handles formats:
 *   <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
 *   <account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<digest>
 */
function ecrArnFromUri(uri: string, region?: string): string | undefined {
  // Match private ECR URIs: <account>.dkr.ecr.<region>.<dns-suffix>/<repo>[:<tag>|@<digest>]
  const match = /^(\d{12})\.dkr\.ecr\.([^.]+)\.[^/]+\/([^:@]+)/.exec(uri);
  if (!match) return undefined;
  const account = match[1];
  const ecrRegion = match[2] ?? region;
  const repoName = match[3];
  if (!ecrRegion || !repoName) return undefined;
  return `${arnPrefix(ecrRegion)}:ecr:${ecrRegion}:${account}:repository/${repoName}`;
}

export function isPathSkill(skill: HarnessSkill): skill is HarnessSkillPathSource {
  return 'path' in skill && !('gitUrl' in skill);
}

function isS3Skill(skill: HarnessSkill): skill is HarnessSkillS3Source {
  return 's3Uri' in skill;
}

/**
 * Parse an s3:// skill URI into the bucket name and its object ARN.
 * The exported agent fetches skills with boto3 at runtime (skills/fetcher.py),
 * so the runtime execution role needs s3:ListBucket on the bucket and
 * s3:GetObject on the objects under the prefix — permissions the managed
 * harness never needed (it fetches skill files service-side).
 *
 * Returns undefined for a malformed URI (no bucket).
 */
function parseS3SkillArns(
  s3Uri: string,
  region?: string
): { bucket: string; bucketArn: string; objectArn: string } | undefined {
  const withoutScheme = s3Uri.replace(/^s3:\/\//, '');
  const [bucket, ...prefixParts] = withoutScheme.split('/');
  if (!bucket) return undefined;
  // S3 ARNs are partition-qualified but region/account-less: arn:<partition>:s3:::<bucket>
  const partition = arnPrefix(region ?? 'us-east-1'); // arnPrefix -> "arn:aws" | "arn:aws-us-gov" | "arn:aws-cn"
  const bucketArn = `${partition}:s3:::${bucket}`;
  const prefix = prefixParts.join('/').replace(/\/+$/, '');
  const objectArn = prefix ? `${bucketArn}/${prefix}/*` : `${bucketArn}/*`;
  return { bucket, bucketArn, objectArn };
}

function isGitSkill(skill: HarnessSkill): skill is HarnessSkillGitSource {
  return 'gitUrl' in skill;
}

function isAwsSkill(skill: HarnessSkill): skill is HarnessSkillAwsSkillsSource {
  return 'awsSkills' in skill;
}

function isToolIncluded(toolType: HarnessToolType, spec: HarnessSpec, allowedPatterns: string[]): boolean {
  const tool = spec.tools.find(t => t.type === toolType);
  if (!tool) return false;
  return matchesAllowedTools(tool.name, allowedPatterns);
}

function matchesAllowedTools(toolName: string, patterns: string[]): boolean {
  if (patterns.includes('*')) return true;
  // Mirrors Harness runtime _matches() logic: tool_name is "server/tool" qualified
  for (const pattern of patterns) {
    if (pattern === toolName) return true;
    if (pattern.startsWith('@')) {
      const slashIdx = pattern.indexOf('/', 1);
      const pServer = slashIdx === -1 ? pattern.slice(1) : pattern.slice(1, slashIdx);
      const pTool = slashIdx === -1 ? '*' : pattern.slice(slashIdx + 1);
      const slashInName = toolName.indexOf('/');
      if (slashInName === -1) {
        // MCP tools stored as "server_tool" flat names — keep legacy behaviour
        if (fnmatch(`${pServer}_${pTool}`, toolName)) return true;
      } else {
        // Qualified names like "builtin/shell"
        const nameServer = toolName.slice(0, slashInName);
        const nameTool = toolName.slice(slashInName + 1);
        if (fnmatch(pServer, nameServer) && fnmatch(pTool, nameTool)) return true;
      }
    } else {
      if (fnmatch(pattern, toolName)) return true;
    }
  }
  return false;
}

function resolveTruncationConfig(truncation: HarnessTruncationConfig | undefined): Record<string, unknown> | undefined {
  if (!truncation?.config) return undefined;
  const { strategy, config } = truncation;
  if (strategy === 'sliding_window' && 'slidingWindow' in config) {
    const sw = config.slidingWindow;
    return sw?.messagesCount !== undefined ? { window_size: sw.messagesCount } : undefined;
  }
  if (strategy === 'summarization' && 'summarization' in config) {
    const s = config.summarization as Record<string, unknown>;
    const keyMap: Record<string, string> = {
      summaryRatio: 'summary_ratio',
      preserveRecentMessages: 'preserve_recent_messages',
      summarizationSystemPrompt: 'summarization_system_prompt',
    };
    const out = Object.fromEntries(
      Object.entries(keyMap)
        .filter(([k]) => s[k] !== undefined)
        .map(([k, v]) => [v, s[k]])
    );
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function isBuiltinIncluded(builtinName: string, patterns: string[]): boolean {
  // Mirrors Harness runtime: builtins are keyed as "builtin/<name>", so only @builtin or @builtin/<name> patterns match.
  // Plain "shell" does NOT match the "builtin/shell" builtin (it would match a tool literally named "shell").
  return matchesAllowedTools(`builtin/${builtinName}`, patterns);
}

/**
 * Build connections for the browser / code-interpreter tools (so the CDK generates their IAM at
 * deploy) and emit only the genuinely-non-IAM note (browser requires a Container build). Returns
 * the connections to add to the exported agent.
 */
interface BrowserCodeInterpreterResult {
  /** Browser/code-interpreter connections (IAM + env wiring generated at deploy). */
  connections: Connection[];
  /** True when the browser tool is included AND the build can run it (Container). */
  hasBrowser: boolean;
  /** True when the code-interpreter tool is included. */
  hasCodeInterpreter: boolean;
  /** Discovery env var the generated code reads for the browser identifier (custom ARN only). */
  browserIdentifierEnvVar?: string;
  /** Discovery env var the generated code reads for the code-interpreter identifier (custom ARN only). */
  codeInterpreterIdentifierEnvVar?: string;
}

/**
 * The single owner of browser/code-interpreter resolution: extracts + validates each tool's ARN
 * exactly once and derives the connection, the local discovery env var, and the render-config
 * identifier env var from the same values — so the IAM grant, the injected env var, and the name
 * baked into the generated code can never diverge. Browser requires a Container build; in CodeZip
 * it is excluded (no connection, no identifier) with an explanatory note.
 */
function resolveBrowserCodeInterpreterConnections(
  spec: HarnessSpec,
  allowedToolPatterns: string[],
  buildType: BuildType,
  context: ResolvedHarnessContext
): BrowserCodeInterpreterResult {
  const result: BrowserCodeInterpreterResult = { connections: [], hasBrowser: false, hasCodeInterpreter: false };
  const agentName = context.targetAgentName;

  if (isToolIncluded('agentcore_browser', spec, allowedToolPatterns)) {
    // Browser requires a Container build (Playwright driver can't spawn subprocesses in the CodeZip
    // Lambda sandbox). In CodeZip it is excluded entirely — note only, no connection/identifier.
    if (buildType !== 'Container') {
      context.exportNotes.push({
        category: BROWSER_CODZIP_NOTE_CATEGORY,
        message:
          'The browser tool requires a Container build to run. In a CodeZip (Lambda-style) runtime the ' +
          'Playwright node driver cannot be executed and the tool will fail at invocation time.\n\n' +
          'Re-export with `--build Container` to include browser tool support:\n\n' +
          `  agentcore export harness --name ${spec.name} --target-agent-name ${agentName} --build Container`,
      });
    } else {
      result.hasBrowser = true;
      const rawArn = extractRawToolArn(spec, 'agentcore_browser', 'agentCoreBrowser', 'browserArn');
      const arn = validToolArn(rawArn, 'browser');
      if (arn) {
        const id = externalConnectionId('browser', arn);
        const envVar = connectionEnvVarName('BROWSER', id, 'ID');
        result.connections.push({ id, to: { type: 'browser', arn } });
        result.browserIdentifierEnvVar = envVar;
        context.localEnvVars[envVar] = resourceIdFromArn(arn);
      } else {
        // No custom ARN (or malformed) → AWS-managed default browser; connection grants browser/*.
        if (rawArn) context.exportNotes.push(buildMalformedToolArnNote('browser', rawArn));
        result.connections.push({ id: 'browser-default', to: { type: 'browser' } });
      }
    }
  }

  if (isToolIncluded('agentcore_code_interpreter', spec, allowedToolPatterns)) {
    result.hasCodeInterpreter = true;
    const rawArn = extractRawToolArn(
      spec,
      'agentcore_code_interpreter',
      'agentCoreCodeInterpreter',
      'codeInterpreterArn'
    );
    const arn = validToolArn(rawArn, 'code-interpreter');
    if (arn) {
      const id = externalConnectionId('codeInterpreter', arn);
      const envVar = connectionEnvVarName('CODE_INTERPRETER', id, 'ID');
      result.connections.push({ id, to: { type: 'codeInterpreter', arn } });
      result.codeInterpreterIdentifierEnvVar = envVar;
      context.localEnvVars[envVar] = resourceIdFromArn(arn);
    } else {
      if (rawArn) context.exportNotes.push(buildMalformedToolArnNote('code-interpreter', rawArn));
      result.connections.push({ id: 'codeInterpreter-default', to: { type: 'codeInterpreter' } });
    }
  }

  return result;
}

/**
 * Note emitted when a harness supplies a browser/code-interpreter ARN that does not match the
 * expected ARN shape. The exported agent falls back to the AWS-managed default (a different
 * resource, with a broader `*` IAM grant), so the user is told to verify and fix the value rather
 * than silently get the wrong tool target.
 */
function buildMalformedToolArnNote(kind: 'browser' | 'code-interpreter', rawArn: string): ExportNote {
  return {
    category: MALFORMED_TOOL_ARN_NOTE_CATEGORY,
    message:
      `The ${kind} tool specified ARN "${rawArn}", which is not a valid bedrock-agentcore ${kind} ARN. ` +
      `The exported agent will use the AWS-managed default ${kind} instead (a different resource, granted ` +
      `broader \`${kind}/*\` permissions). If you intended to target a specific ${kind}, fix the ARN in the ` +
      `connection on this agent in agentcore/agentcore.json and re-deploy.`,
  };
}

/** Raw ARN string from a tool's config (no validation). */
function extractRawToolArn(
  spec: HarnessSpec,
  toolType: HarnessToolType,
  configKey: string,
  arnField: string
): string | undefined {
  const tool = spec.tools.find(t => t.type === toolType);
  if (!tool?.config || !(configKey in tool.config)) return undefined;
  return (tool.config as Record<string, Record<string, string | undefined>>)[configKey]?.[arnField];
}

/** Returns the ARN only if it is a well-formed browser/code-interpreter ARN; else undefined (→ default). */
function validToolArn(arn: string | undefined, kind: 'browser' | 'code-interpreter'): string | undefined {
  if (!arn) return undefined;
  // Reuse the canonical schema patterns (single source of truth for the two legitimate
  // resource-segment forms: customer-owned `<kind>-custom/...` and AWS-managed `<kind>/...`).
  const re = kind === 'browser' ? BROWSER_ARN_PATTERN : CODE_INTERPRETER_ARN_PATTERN;
  return re.test(arn) ? arn : undefined;
}

function fnmatch(pattern: string, str: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return re.test(str);
}
