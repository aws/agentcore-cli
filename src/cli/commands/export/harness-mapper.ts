import { APP_DIR } from '../../../lib';
import { ValidationError } from '../../../lib/errors/types';
import type {
  AgentEnvSpec,
  BuildType,
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
  BROWSER_IAM_POLICY_NOTE_CATEGORY,
  CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY,
  CONTAINER_URI_ECR_PULL_NOTE_CATEGORY,
  CONTAINER_URI_NOTE_CATEGORY,
  EXTERNAL_GATEWAY_NOTE_CATEGORY,
  GATEWAY_IAM_POLICY_NOTE_CATEGORY,
  GIT_SKILLS_CONTAINER_NOTE_CATEGORY,
  MCP_HEADER_CREDS_NOTE_CATEGORY,
  MEMORY_ARN_NOTE_CATEGORY,
  PATH_SKILLS_NOTE_CATEGORY,
  S3_SKILLS_IAM_POLICY_NOTE_CATEGORY,
} from './constants';
import type { HarnessMappingResult, ResolvedHarnessContext } from './types';

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
  const memoryResult = resolveMemoryProviders(spec, context);
  const gatewayResult = resolveGatewayProviders(spec, context, allowedToolPatterns);
  const hasGateway = gatewayResult.providers.length > 0;
  addBrowserCodeInterpreterNotes(spec, allowedToolPatterns, buildType, context);
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
    const arns = s3Skills
      .map(s => parseS3SkillArns(s.s3Uri, context.region))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    if (arns.length > 0) {
      const objectResources = [...new Set(arns.map(a => a.objectArn))];
      const bucketResources = [...new Set(arns.map(a => a.bucketArn))];
      const fmt = (rs: string[]) => rs.map(r => `'${r}'`).join(', ');
      const agentName = context.targetAgentName ?? 'YourAgentName';
      context.exportNotes.push({
        category: S3_SKILLS_IAM_POLICY_NOTE_CATEGORY,
        message:
          `This agent downloads its S3 skills (${s3Skills.map(s => s.s3Uri).join(', ')}) at runtime with boto3. ` +
          `The exported runtime execution role is not automatically granted permission to read them, so the ` +
          `agent will fail on its first invocation with an S3 AccessDenied.\n\n` +
          `Add the following to agentcore/cdk/lib/cdk-stack.ts after \`this.application\` is created,\n` +
          `replacing "${agentName}" if you renamed the agent:\n\n` +
          `  const agentEnv = this.application.environments.get('${agentName}');\n` +
          `  agentEnv?.runtime.role.addToPrincipalPolicy(\n` +
          `    new iam.PolicyStatement({\n` +
          `      actions: ['s3:GetObject'],\n` +
          `      resources: [${fmt(objectResources)}],\n` +
          `    })\n` +
          `  );\n` +
          `  agentEnv?.runtime.role.addToPrincipalPolicy(\n` +
          `    new iam.PolicyStatement({\n` +
          `      actions: ['s3:ListBucket'],\n` +
          `      resources: [${fmt(bucketResources)}],\n` +
          `    })\n` +
          `  );`,
      });
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
    ...buildToolsRenderConfig(spec, allowedToolPatterns, buildType),
    hasExecutionLimits,
    isExportHarness: true,
    modelId: spec.model.modelId,
    // System prompt (written verbatim into main.py)
    systemPromptText: context.systemPrompt,
    actorId: spec.memory?.mode === 'existing' ? spec.memory.actorId : undefined,
  };

  const agentEnvSpec = buildAgentEnvSpec(context, targetAgentName, buildType);

  return {
    renderConfig,
    agentEnvSpec,
    credentialEntry: identityResult.credentialEntry,
    mcpCredentialEntries: mcpResolution.credentialEntries,
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

/** Inline, builtin, and browser/code-interpreter tools (after allowedTools filter). */
function buildToolsRenderConfig(
  spec: HarnessSpec,
  allowedToolPatterns: string[],
  buildType: BuildType
): Pick<
  AgentRenderConfig,
  | 'inlineFunctionTools'
  | 'hasBrowser'
  | 'browserIdentifier'
  | 'hasCodeInterpreter'
  | 'codeInterpreterIdentifier'
  | 'hasShell'
  | 'hasFileOperations'
> {
  return {
    inlineFunctionTools: resolveInlineFunctionTools(spec, allowedToolPatterns),
    // Browser requires a Container build (Playwright driver can't spawn subprocesses in CodeZip Lambda sandbox).
    hasBrowser: isToolIncluded('agentcore_browser', spec, allowedToolPatterns) && buildType === 'Container',
    browserIdentifier: extractToolIdentifier(spec, 'agentcore_browser', 'agentCoreBrowser', 'browserArn'),
    hasCodeInterpreter: isToolIncluded('agentcore_code_interpreter', spec, allowedToolPatterns),
    codeInterpreterIdentifier: extractToolIdentifier(
      spec,
      'agentcore_code_interpreter',
      'agentCoreCodeInterpreter',
      'codeInterpreterArn'
    ),
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
  buildType: BuildType
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
    ...(spec.tags && { tags: spec.tags }),
    ...buildFilesystemConfigurations(spec.sessionStoragePath, spec.efsAccessPoints, spec.s3AccessPoints),
  };
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
      throw new ValidationError(
        'Harness uses the "lite_llm" model provider, which the Strands export does not support. ' +
          'Switch the harness to bedrock, open_ai, or gemini before exporting.'
      );
  }
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

    // External memory — hardcode ARN as env var
    context.exportNotes.push({
      category: MEMORY_ARN_NOTE_CATEGORY,
      message:
        `The harness memory was referenced by ARN (${memArn}) and could not be matched to a ` +
        'same-project memory. A MEMORY_ARN env var will be used. Ensure the runtime IAM execution role ' +
        'has bedrock-agentcore:GetMemory and bedrock-agentcore:InvokeMemory on the above ARN.',
    });
    return {
      providers: [{ name: 'ExternalMemory', envVarName: 'MEMORY_ARN', strategies: [] }],
    };
  }

  return { providers: [] };
}

// ============================================================================
// Gateway providers
// ============================================================================

interface GatewayResult {
  providers: GatewayProviderRenderConfig[];
}

function resolveGatewayProviders(
  spec: HarnessSpec,
  context: ResolvedHarnessContext,
  allowedToolPatterns: string[]
): GatewayResult {
  const providers: GatewayProviderRenderConfig[] = [];

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
      // External gateway — derive URL from ARN
      const hardcodedUrl = deriveGatewayUrl(gatewayArn);
      context.exportNotes.push({
        category: EXTERNAL_GATEWAY_NOTE_CATEGORY,
        message:
          `Gateway tool "${tool.name}" (ARN: ${gatewayArn}) was not found in this project's deployed state. ` +
          `The URL has been hardcoded as "${hardcodedUrl}" in mcp_client/client.py. ` +
          'If the ARN changes (e.g. after re-deployment), update mcp_client/client.py manually.',
      });

      const outboundAuth = gwConfig.outboundAuth;
      const authType = outboundAuth
        ? 'oauth' in outboundAuth
          ? 'CUSTOM_JWT'
          : 'awsIam' in outboundAuth
            ? 'AWS_IAM'
            : 'NONE'
        : 'AWS_IAM';

      if (authType === 'AWS_IAM') {
        context.exportNotes.push({
          category: GATEWAY_IAM_POLICY_NOTE_CATEGORY,
          message:
            `Gateway tool "${tool.name}" (ARN: ${gatewayArn}) uses AWS_IAM auth. ` +
            `The exported runtime execution role is not automatically granted permission to invoke it.\n\n` +
            `Add the following to agentcore/cdk/lib/cdk-stack.ts after \`this.application\` is created,\n` +
            `replacing "YourAgentName" with the name of the exported agent (e.g. "${context.targetAgentName ?? 'MyHarnessAgent'}"):\n\n` +
            `  const agentEnv = this.application.environments.get('${context.targetAgentName ?? 'YourAgentName'}');\n` +
            `  agentEnv?.runtime.role.addToPrincipalPolicy(\n` +
            `    new iam.PolicyStatement({\n` +
            `      actions: ['bedrock-agentcore:InvokeGateway'],\n` +
            `      resources: ['${gatewayArn}'],\n` +
            `    })\n` +
            `  );`,
        });
      }

      const provider: GatewayProviderRenderConfig = {
        name: tool.name,
        envVarName: '',
        authType,
        hardcodedUrl,
      };

      if (authType === 'CUSTOM_JWT' && outboundAuth && 'oauth' in outboundAuth) {
        provider.credentialProviderName = computeManagedOAuthCredentialName(tool.name);
        const scopes = outboundAuth.oauth.scopes;
        if (scopes?.length) {
          provider.scopes = scopes.join(' ');
        }
      }

      providers.push(provider);
    }
  }

  return { providers };
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

function isPathSkill(skill: HarnessSkill): skill is HarnessSkillPathSource {
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

function extractToolIdentifier(
  spec: HarnessSpec,
  toolType: HarnessToolType,
  configKey: string,
  arnField: string
): string | undefined {
  const tool = spec.tools.find(t => t.type === toolType);
  if (!tool?.config || !(configKey in tool.config)) return undefined;
  const arn = (tool.config as Record<string, Record<string, string | undefined>>)[configKey]?.[arnField];
  if (!arn) return undefined;
  // ARN format: arn:aws:bedrock-agentcore:<region>:<account>:<resource-type>/<identifier>
  const slashIdx = arn.lastIndexOf('/');
  return slashIdx === -1 ? undefined : arn.slice(slashIdx + 1);
}

function isBuiltinIncluded(builtinName: string, patterns: string[]): boolean {
  // Mirrors Harness runtime: builtins are keyed as "builtin/<name>", so only @builtin or @builtin/<name> patterns match.
  // Plain "shell" does NOT match the "builtin/shell" builtin (it would match a tool literally named "shell").
  return matchesAllowedTools(`builtin/${builtinName}`, patterns);
}

function addBrowserCodeInterpreterNotes(
  spec: HarnessSpec,
  allowedToolPatterns: string[],
  buildType: BuildType,
  context: ResolvedHarnessContext
): void {
  const agentName = context.targetAgentName;

  if (isToolIncluded('agentcore_browser', spec, allowedToolPatterns)) {
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
      const browserTool = spec.tools.find(t => t.type === 'agentcore_browser');
      const customArn =
        browserTool?.config && 'agentCoreBrowser' in browserTool.config
          ? (browserTool.config as { agentCoreBrowser: { browserArn?: string } }).agentCoreBrowser.browserArn
          : undefined;
      const resource = customArn ?? `arn:*:bedrock-agentcore:\${Stack.of(this).region}:aws:browser/*`;
      context.exportNotes.push({
        category: BROWSER_IAM_POLICY_NOTE_CATEGORY,
        message:
          `The exported runtime execution role is not automatically granted permission to use the browser tool.\n\n` +
          `Add the following to agentcore/cdk/lib/cdk-stack.ts after \`this.application\` is created:\n\n` +
          `  const agentEnv = this.application.environments.get('${agentName}');\n` +
          `  agentEnv?.runtime.role.addToPrincipalPolicy(\n` +
          `    new iam.PolicyStatement({\n` +
          `      actions: [\n` +
          `        'bedrock-agentcore:StartBrowserSession',\n` +
          `        'bedrock-agentcore:StopBrowserSession',\n` +
          `        'bedrock-agentcore:GetBrowserSession',\n` +
          `        'bedrock-agentcore:ListBrowserSessions',\n` +
          `        'bedrock-agentcore:UpdateBrowserStream',\n` +
          `        'bedrock-agentcore:ConnectBrowserAutomationStream',\n` +
          `        'bedrock-agentcore:ConnectBrowserLiveViewStream',\n` +
          `      ],\n` +
          `      resources: [\`${resource}\`],\n` +
          `    })\n` +
          `  );`,
      });
    }
  }

  if (isToolIncluded('agentcore_code_interpreter', spec, allowedToolPatterns)) {
    const ciTool = spec.tools.find(t => t.type === 'agentcore_code_interpreter');
    const customArn =
      ciTool?.config && 'agentCoreCodeInterpreter' in ciTool.config
        ? (ciTool.config as { agentCoreCodeInterpreter: { codeInterpreterArn?: string } }).agentCoreCodeInterpreter
            .codeInterpreterArn
        : undefined;
    const resource = customArn ?? `arn:*:bedrock-agentcore:\${Stack.of(this).region}:aws:code-interpreter/*`;
    context.exportNotes.push({
      category: CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY,
      message:
        `The exported runtime execution role is not automatically granted permission to use the code interpreter tool.\n\n` +
        `Add the following to agentcore/cdk/lib/cdk-stack.ts after \`this.application\` is created:\n\n` +
        `  const agentEnv = this.application.environments.get('${agentName}');\n` +
        `  agentEnv?.runtime.role.addToPrincipalPolicy(\n` +
        `    new iam.PolicyStatement({\n` +
        `      actions: [\n` +
        `        'bedrock-agentcore:StartCodeInterpreterSession',\n` +
        `        'bedrock-agentcore:StopCodeInterpreterSession',\n` +
        `        'bedrock-agentcore:GetCodeInterpreterSession',\n` +
        `        'bedrock-agentcore:ListCodeInterpreterSessions',\n` +
        `        'bedrock-agentcore:InvokeCodeInterpreter',\n` +
        `      ],\n` +
        `      resources: [\`${resource}\`],\n` +
        `    })\n` +
        `  );`,
    });
  }
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
