import { ValidationError, getWorkingDirectory, serializeResult } from '../../../lib';
import type {
  BuildType,
  HarnessModelProvider,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  SDKFramework,
  TargetLanguage,
} from '../../../schema';
import { LIFECYCLE_TIMEOUT_MAX, LIFECYCLE_TIMEOUT_MIN } from '../../../schema';
import { isCapacityProviderArn } from '../../../schema';
import { ANSI, COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { ADDITIONAL_PARAMS_JSON_ERROR } from '../../primitives/constants';
import { harnessPrimitive } from '../../primitives/registry';
import { runCliCommand, withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import {
  AgentFramework,
  AgentLanguage,
  AgentProtocol,
  AgentSource,
  MemoryType,
  ModelProvider as ModelProviderEnum,
  NetworkMode as NetworkModeEnum,
  BuildType as TelemetryBuildType,
  standardize,
} from '../../telemetry/schemas/common-shapes.js';
import { renderTUI } from '../../tui';
import { requireTTY } from '../../tui/guards';
import {
  resolveAndValidateFilesystemMounts,
  validateCapacityProviderVolumeMounts,
  zipCapacityProviderVolumePairs,
} from '../shared/filesystem-utils';
import { parseCommaSeparatedList } from '../shared/vpc-utils';
import {
  type ProgressCallback,
  createProject,
  createProjectWithAgent,
  getDryRunInfo,
  getHarnessDryRunInfo,
} from './action';
import { createProjectWithHarness } from './harness-action';
import { normalizeHarnessModelProvider, validateCreateHarnessOptions } from './harness-validate';
import type { CreateOptions } from './types';
import { validateCreateOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

/** Render CreateScreen for interactive TUI mode */
function handleCreateTUI(): Promise<void> {
  return renderTUI({
    initialRoute: { name: 'create' },
    enterAltScreen: false,
    actionOnBack: 'exit',
    isInteractive: false,
  });
}

/** Print completion summary after successful create */
function printCreateSummary(
  projectName: string,
  agentName: string | undefined,
  language: string | undefined,
  framework: string | undefined
): void {
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log('');

  // Created summary
  console.log(`${dim}Created:${reset}`);
  console.log(`  ${projectName}/`);
  if (agentName) {
    const frameworkLabel = framework ?? 'agent';
    const agentPath = `app/${agentName}/`;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(agentPath.length, agentcorePath.length);
    console.log(`    ${agentPath.padEnd(maxPathLen)}  ${dim}${language} agent (${frameworkLabel})${reset}`);
    console.log(`    ${agentcorePath.padEnd(maxPathLen)}  ${dim}Config and CDK project${reset}`);
  } else {
    console.log(`    agentcore/  ${dim}Config and CDK project${reset}`);
  }
  console.log('');

  // Success and next steps
  console.log(`${green}Project created successfully!${reset}`);
  console.log('');
  console.log('To continue, navigate to your new project:');
  console.log('');
  console.log(`  ${cyan}cd ${projectName}${reset}`);
  console.log(`  ${cyan}agentcore${reset}`);
  console.log('');
}

/** Flags that trigger the agent/runtime path. `memory` (none/shortTerm/longAndShortTerm) is an
 * agent-only concept — harnesses use --memory-mode/--no-memory — so it routes to the agent path
 * (and conflicts with harness-only flags) rather than being silently ignored on the harness path. */
const AGENT_PATH_FLAGS = [
  'framework',
  'language',
  'build',
  'protocol',
  'type',
  'agentId',
  'agentAliasId',
  'memory',
  'capacityProvider',
] as const;

/** Flags that are harness-only */
const HARNESS_ONLY_FLAGS = [
  'modelId',
  'apiKeyArn',
  'apiBase',
  'additionalParams',
  'maxIterations',
  'maxTokens',
  'timeout',
  'truncationStrategy',
  'container',
] as const;

/** Determines if the agent path should be taken based on provided flags */
function isAgentPath(options: CreateOptions): boolean {
  return AGENT_PATH_FLAGS.some(flag => options[flag] !== undefined);
}

/** Determines if any harness-only flags are present */
function hasHarnessOnlyFlags(options: CreateOptions): boolean {
  return HARNESS_ONLY_FLAGS.some(flag => options[flag] !== undefined);
}

/** Print completion summary after successful harness create */
function printCreateHarnessSummary(projectName: string, harnessName: string): void {
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log('');

  // Created summary
  console.log(`${dim}Created:${reset}`);
  console.log(`  ${projectName}/`);
  console.log(`    agentcore/              ${dim}Config and CDK project${reset}`);
  console.log(`    app/${harnessName}/  ${dim}Harness config${reset}`);
  console.log('');

  // Success and next steps
  console.log(`${green}Harness project created successfully!${reset}`);
  console.log('');
  console.log('To continue:');
  console.log(`  ${cyan}cd ${projectName}${reset}`);
  console.log(`  ${cyan}agentcore deploy${reset}`);
  console.log('');
}

/** Handle CLI mode for the harness path */
async function handleCreateHarnessCLI(options: CreateOptions): Promise<void> {
  const commandCwd = getWorkingDirectory();
  const cwd = options.outputDir ?? commandCwd;
  const name = options.name ?? options.projectName;
  const projectName = options.projectName ?? name;

  // Single source for the harness validation input, shared by the dry-run and telemetry-wrapped
  // paths below. Keeping ONE object prevents the two call sites from drifting — forwarding a field
  // on one path but not the other is exactly what caused the create-harness VPC validation blocker.
  const harnessValidationInput = {
    name,
    projectName,
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    apiKeyArn: options.apiKeyArn,
    container: options.container,
    networkMode: options.networkMode,
    subnets: options.subnets,
    securityGroups: options.securityGroups,
    vpcId: options.vpcId,
    efsAccessPointArn: options.efsAccessPointArn,
    efsMountPath: options.efsMountPath,
    s3AccessPointArn: options.s3AccessPointArn,
    s3MountPath: options.s3MountPath,
  };

  // Handle dry-run mode (no telemetry for dry-run)
  if (options.dryRun) {
    const validation = validateCreateHarnessOptions(harnessValidationInput, cwd);
    if (!validation.valid) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: validation.error }));
      } else {
        console.error(validation.error);
      }
      process.exit(1);
    }
    const result = getHarnessDryRunInfo({ name: name!, projectName, cwd });
    if (options.json) {
      console.log(JSON.stringify(serializeResult(result)));
    } else if (result.success) {
      console.log('Dry run - would create:');
      for (const path of result.wouldCreate ?? []) {
        console.log(`  ${path}`);
      }
    }
    process.exit(0);
  }

  const result = await withCommandRunTelemetry(
    'create',
    {
      agent_environment: 'harness' as const,
      has_agent: true,
      model_provider: standardize(ModelProviderEnum, options.modelProvider ?? 'bedrock'),
      // Harness memory is opt-in and defaults to disabled; only an explicit managed/existing request
      // (not modeled by the legacy --harness-memory boolean) would be non-'none'.
      memory_type: standardize(MemoryType, 'none'),
      network_mode: standardize(NetworkModeEnum, options.networkMode ?? 'public'),
    },
    async () => {
      const validation = validateCreateHarnessOptions(harnessValidationInput, cwd);
      if (!validation.valid) {
        return { success: false as const, error: new ValidationError(validation.error!) };
      }

      // Progress callback
      const onProgress: ProgressCallback | undefined = options.json
        ? undefined
        : (step, status) => {
            if (status === 'done') console.log(`${ANSI.green}[done]${ANSI.reset}  ${step}`);
            else if (status === 'error') console.log(`${ANSI.red}[error]${ANSI.reset} ${step}`);
          };

      const provider = (
        options.modelProvider ? normalizeHarnessModelProvider(options.modelProvider) : 'bedrock'
      ) as HarnessModelProvider;
      const defaultModelIds: Record<string, string> = {
        bedrock: 'global.anthropic.claude-sonnet-4-6',
        open_ai: 'gpt-5',
        gemini: 'gemini-2.5-flash',
        lite_llm: 'anthropic/claude-sonnet-4-5',
      };
      const modelId = options.modelId ?? defaultModelIds[provider] ?? 'global.anthropic.claude-sonnet-4-6';

      const containerOption = harnessPrimitive.parseContainerFlag(options.container);

      let additionalParams: Record<string, unknown> | undefined;
      if (options.additionalParams) {
        try {
          additionalParams = JSON.parse(options.additionalParams) as Record<string, unknown>;
        } catch {
          throw new Error(ADDITIONAL_PARAMS_JSON_ERROR);
        }
      }

      const { efsMounts: harnessEfsMounts, s3Mounts: harnessS3Mounts } = await resolveAndValidateFilesystemMounts(
        options,
        parseCommaSeparatedList
      );

      return createProjectWithHarness({
        name: name!,
        projectName: projectName!,
        cwd,
        modelProvider: provider,
        modelId,
        apiKeyArn: options.apiKeyArn,
        apiBase: options.apiBase,
        additionalParams,
        containerUri: containerOption.containerUri,
        dockerfilePath: containerOption.dockerfilePath,
        dockerfileBaseDir: commandCwd,
        skipMemory: options.harnessMemory === false,
        maxIterations: options.maxIterations ? Number(options.maxIterations) : undefined,
        maxTokens: options.maxTokens ? Number(options.maxTokens) : undefined,
        timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
        truncationStrategy: options.truncationStrategy as 'sliding_window' | 'summarization' | undefined,
        networkMode: options.networkMode as NetworkMode | undefined,
        subnets: parseCommaSeparatedList(options.subnets),
        securityGroups: parseCommaSeparatedList(options.securityGroups),
        vpcId: options.vpcId,
        idleTimeout: options.idleTimeout ? Number(options.idleTimeout) : undefined,
        maxLifetime: options.maxLifetime ? Number(options.maxLifetime) : undefined,
        sessionStoragePath: options.sessionStorageMountPath,
        efsAccessPoints: harnessEfsMounts,
        s3AccessPoints: harnessS3Mounts,
        skipGit: options.skipGit,
        skipInstall: options.skipInstall,
        onProgress,
      });
    }
  );

  if (options.json) {
    console.log(JSON.stringify(serializeResult(result)));
  } else if (result.success) {
    printCreateHarnessSummary(projectName!, name!);
  } else {
    console.error(result.error instanceof Error ? result.error.message : 'Create failed');
  }
  process.exit(result.success ? 0 : 1);
}

/** Handle CLI mode with progress output */
async function handleCreateCLI(options: CreateOptions): Promise<void> {
  const cwd = options.outputDir ?? getWorkingDirectory();
  const name = options.name ?? options.projectName;
  const projectName = options.projectName ?? name;

  // Handle dry-run mode (no telemetry for dry-run)
  if (options.dryRun) {
    const validation = validateCreateOptions(options, cwd);
    if (!validation.valid) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: validation.error }));
      } else {
        console.error(validation.error);
      }
      process.exit(1);
    }
    const result = getDryRunInfo({ name: name!, projectName, cwd, language: options.language });
    if (options.json) {
      console.log(JSON.stringify(serializeResult(result)));
    } else if (result.success) {
      console.log('Dry run - would create:');
      for (const path of result.wouldCreate ?? []) {
        console.log(`  ${path}`);
      }
    }
    process.exit(0);
  }

  const knownAttrs = {
    agent_environment: 'runtime' as const,
    agent_language: standardize(AgentLanguage, options.language),
    agent_framework: standardize(AgentFramework, options.framework),
    model_provider: standardize(ModelProviderEnum, options.modelProvider),
    memory_type: standardize(MemoryType, options.memory ?? 'none'),
    agent_protocol: standardize(AgentProtocol, options.protocol ?? 'http'),
    build_type: standardize(TelemetryBuildType, options.build ?? 'codezip'),
    agent_source: standardize(AgentSource, options.type ?? 'create'),
    network_mode: standardize(NetworkModeEnum, options.networkMode ?? 'public'),
    has_agent: options.agent !== false,
    has_capacity_provider: !!options.capacityProvider,
    capacity_provider_by_arn: !!options.capacityProvider && isCapacityProviderArn(options.capacityProvider),
    cp_volume_mount_count: options.cpVolumeName?.length ?? 0,
  };

  await runCliCommand(
    'create',
    !!options.json,
    async () => {
      const validation = validateCreateOptions(options, cwd);
      if (!validation.valid) {
        throw new ValidationError(validation.error!);
      }
      const green = '\x1b[32m';
      const reset = '\x1b[0m';

      // Progress callback for real-time output
      const onProgress: ProgressCallback | undefined = options.json
        ? undefined
        : (step, status) => {
            if (status === 'done') {
              console.log(`${green}[done]${reset}  ${step}`);
            } else if (status === 'error') {
              console.log(`\x1b[31m[error]${reset} ${step}`);
            }
            // 'start' is silent - we only show when done
          };

      // Commander.js --no-agent sets agent=false, not noAgent=true
      const skipAgent = options.agent === false;

      // Build EFS/S3 mount pairs, resolve VPC, and run async filesystem validation (Levels 1–3)
      const { efsMounts: efsPairsMounts, s3Mounts: s3PairsMounts } = await resolveAndValidateFilesystemMounts(
        options,
        parseCommaSeparatedList
      );

      // Capacity provider attach — mirror the `add agent` CLI semantics (name-or-ARN + paired
      // --cp-volume-* flags). A CP supplies its own network topology, so --network-mode is not
      // settable alongside it (neither PUBLIC nor VPC).
      if (options.capacityProvider && options.networkMode !== undefined) {
        throw new ValidationError(
          '--network-mode cannot be set when attaching a capacity provider (--capacity-provider) — the capacity provider supplies the network topology. Remove --network-mode.'
        );
      }
      // A newly-scaffolded project has no capacityProviders[] for an in-project name to resolve
      // against, so only an external capacity provider ARN can be attached at create time. Reject
      // the name form up front rather than scaffolding a project that then fails validation.
      if (options.capacityProvider && !isCapacityProviderArn(options.capacityProvider)) {
        throw new ValidationError(
          `--capacity-provider "${options.capacityProvider}" is a capacity provider name, but a new project has no capacity providers to reference by name. Pass an external capacity provider ARN, or scaffold the project first and then run "agentcore add capacity-provider" followed by "agentcore add agent --capacity-provider ${options.capacityProvider}".`
        );
      }
      const cpVolumePairs = zipCapacityProviderVolumePairs(options.cpVolumeName ?? [], options.cpVolumeMountPath ?? []);
      if (!cpVolumePairs.success) {
        throw new ValidationError(cpVolumePairs.error);
      }
      const cpVolumeCheck = validateCapacityProviderVolumeMounts(cpVolumePairs.mounts);
      if (!cpVolumeCheck.success) {
        throw new ValidationError(cpVolumeCheck.error);
      }
      if (cpVolumePairs.mounts.length > 0 && !options.capacityProvider) {
        throw new ValidationError(
          'Capacity provider volume mounts (--cp-volume-name / --cp-volume-mount-path) require attaching the runtime to a capacity provider (--capacity-provider <name-or-arn>).'
        );
      }
      const capacityProviderConfiguration = options.capacityProvider
        ? isCapacityProviderArn(options.capacityProvider)
          ? { capacityProviderArn: options.capacityProvider }
          : { capacityProviderName: options.capacityProvider }
        : undefined;

      const result = skipAgent
        ? await createProject({
            name: projectName!,
            cwd,
            skipGit: options.skipGit,
            skipInstall: options.skipInstall,
            onProgress,
          })
        : await createProjectWithAgent({
            name: name!,
            projectName,
            cwd,
            type: options.type as 'create' | 'import' | undefined,
            buildType: (options.build as BuildType) ?? 'CodeZip',
            language: (options.language as TargetLanguage) ?? (options.type === 'import' ? 'Python' : undefined),
            framework: options.framework as SDKFramework | undefined,
            modelProvider: options.modelProvider as ModelProvider | undefined,
            apiKey: options.apiKey,
            memory: (options.memory as 'none' | 'shortTerm' | 'longAndShortTerm') ?? 'none',
            protocol: options.protocol as ProtocolMode | undefined,
            agentId: options.agentId,
            agentAliasId: options.agentAliasId,
            region: options.region,
            networkMode: options.networkMode as NetworkMode | undefined,
            subnets: parseCommaSeparatedList(options.subnets),
            securityGroups: parseCommaSeparatedList(options.securityGroups),
            vpcId: options.vpcId,
            idleTimeout: options.idleTimeout ? Number(options.idleTimeout) : undefined,
            maxLifetime: options.maxLifetime ? Number(options.maxLifetime) : undefined,
            sessionStorageMountPath: options.sessionStorageMountPath,
            efsAccessPoints: efsPairsMounts,
            s3AccessPoints: s3PairsMounts,
            capacityProviderConfiguration,
            capacityProviderVolumes: cpVolumePairs.mounts,
            withConfigBundle: options.withConfigBundle,
            skipGit: options.skipGit,
            skipInstall: options.skipInstall,
            skipPythonSetup: options.skipPythonSetup,
            onProgress,
          });

      if (!result.success) {
        throw result.error;
      }

      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        printCreateSummary(projectName!, result.agentName, options.language, options.framework);
        if (options.skipInstall) {
          console.log(
            "\nDependency installation was skipped. Run 'npm install' in agentcore/cdk/ and 'uv sync' in your agent directory manually."
          );
        }
      }

      return knownAttrs;
    },
    knownAttrs
  );
}

export const registerCreate = (program: Command) => {
  const createCmd = program
    .command('create')
    .description(COMMAND_DESCRIPTIONS.create)
    .option('--name <name>', 'Resource name [non-interactive]')
    .option(
      '--project-name <name>',
      'Project name (start with letter, alphanumeric only, max 23 chars) [non-interactive]'
    )
    .option('--no-agent', 'Skip agent creation [non-interactive]')
    .option('--defaults', 'Create a harness project with default settings (this is the default) [non-interactive]')
    .option('--build <type>', 'Build type: CodeZip or Container (default: CodeZip) [non-interactive]')
    .option('--language <language>', 'Target language: Python or TypeScript (default: Python) [non-interactive]')
    .option(
      '--framework <framework>',
      'Agent framework (Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents, VercelAI) [non-interactive]'
    )
    .option('--model-provider <provider>', 'Model provider (Bedrock, Anthropic, OpenAI, Gemini) [non-interactive]')
    .option('--api-key <key>', 'API key for non-Bedrock providers [non-interactive]')
    .option('--memory <option>', 'Memory option (none, shortTerm, longAndShortTerm) [non-interactive]')
    .option('--protocol <protocol>', 'Protocol: HTTP, MCP, A2A, AGUI (default: HTTP) [non-interactive]')
    .option('--type <type>', 'Agent type: create or import (default: create) [non-interactive]')
    .option('--agent-id <id>', 'Bedrock Agent ID (required for --type import) [non-interactive]')
    .option('--agent-alias-id <id>', 'Bedrock Agent Alias ID (required for --type import) [non-interactive]')
    .option('--region <region>', 'AWS region for Bedrock Agent (required for --type import) [non-interactive]')
    .option('--network-mode <mode>', 'Network mode (PUBLIC, VPC) [non-interactive]')
    .option('--subnets <ids>', 'Comma-separated subnet IDs (required for VPC mode) [non-interactive]')
    .option('--security-groups <ids>', 'Comma-separated security group IDs (required for VPC mode) [non-interactive]')
    .option('--vpc-id <id>', 'VPC ID (required for Container builds with VPC mode) [non-interactive]')
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
      'Absolute mount path for session filesystem storage under /mnt (e.g. /mnt/data) [non-interactive]'
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
      'Attach the agent to a capacity provider — an in-project capacity-provider name or an external CP ARN [non-interactive]'
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
    .option('--output-dir <dir>', 'Output directory (default: current directory) [non-interactive]')
    .option('--skip-git', 'Skip git repository initialization [non-interactive]')
    .option('--skip-python-setup', 'Skip Python virtual environment setup [non-interactive]')
    .option('--skip-install', 'Skip all dependency installation (npm install, uv sync) [non-interactive]')
    .option('--dry-run', 'Preview what would be created without making changes [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]');

  createCmd
    .option('--model-id <id>', 'Model ID for harness [non-interactive]')
    .option('--api-key-arn <arn>', 'API key ARN for non-Bedrock harness providers [non-interactive]')
    .option('--api-base <url>', 'Base URL for the harness model provider API endpoint (lite_llm) [non-interactive]')
    .option(
      '--additional-params <json>',
      'Provider-specific harness params as a JSON object (lite_llm) [non-interactive]'
    )
    .option('--no-harness-memory', 'Disable memory for the harness (this is the default) [non-interactive]')
    .option('--max-iterations <n>', 'Max agent loop iterations (harness) [non-interactive]')
    .option('--max-tokens <n>', 'Max tokens per iteration (harness) [non-interactive]')
    .option('--timeout <seconds>', 'Max execution duration in seconds (harness) [non-interactive]')
    .option(
      '--truncation-strategy <strategy>',
      'Truncation strategy: sliding_window or summarization (harness) [non-interactive]'
    )
    .option('--container <uri-or-path>', 'Container image URI or Dockerfile path (harness) [non-interactive]');

  createCmd.action(async (rawOptions: Record<string, unknown>) => {
    const options = rawOptions as Record<string, unknown> & {
      name?: string;
      projectName?: string;
      agent: boolean;
      defaults?: true;
      build?: string;
      language?: string;
      framework?: string;
      modelProvider?: string;
      apiKey?: string;
      memory?: string;
      protocol?: string;
      type?: string;
      agentId?: string;
      agentAliasId?: string;
      region?: string;
      networkMode?: string;
      subnets?: string;
      securityGroups?: string;
      vpcId?: string;
      idleTimeout?: string;
      maxLifetime?: string;
      sessionStorageMountPath?: string;
      capacityProvider?: string;
      cpVolumeName?: string[];
      cpVolumeMountPath?: string[];
      withConfigBundle?: true;
      outputDir?: string;
      skipGit?: true;
      skipPythonSetup?: true;
      skipInstall?: true;
      dryRun?: true;
      json?: true;
      modelId?: string;
      apiKeyArn?: string;
      harnessMemory?: boolean;
      maxIterations?: string;
      maxTokens?: string;
      timeout?: string;
      truncationStrategy?: string;
      container?: string;
    };
    try {
      // Fork between harness and agent paths
      const hasAnyFlag = Boolean(
        options.name ??
        options.projectName ??
        (options.agent === false ? true : null) ??
        options.defaults ??
        options.build ??
        options.language ??
        options.framework ??
        options.modelProvider ??
        options.apiKey ??
        options.memory ??
        options.protocol ??
        options.type ??
        options.agentId ??
        options.agentAliasId ??
        options.region ??
        options.networkMode ??
        options.subnets ??
        options.securityGroups ??
        options.vpcId ??
        options.idleTimeout ??
        options.maxLifetime ??
        options.capacityProvider ??
        (options.cpVolumeName?.length ? true : null) ??
        (options.cpVolumeMountPath?.length ? true : null) ??
        options.outputDir ??
        options.skipGit ??
        options.skipPythonSetup ??
        options.skipInstall ??
        options.dryRun ??
        options.json ??
        options.modelId ??
        options.apiKeyArn ??
        (options.harnessMemory === false ? true : null) ??
        options.maxIterations ??
        options.maxTokens ??
        options.timeout ??
        options.truncationStrategy
      );

      if (!hasAnyFlag) {
        requireTTY();
        await handleCreateTUI();
        return;
      }

      const opts = options as CreateOptions;

      // Conflict detection: agent-path flags + harness-only flags
      if (isAgentPath(opts) && hasHarnessOnlyFlags(opts)) {
        const error =
          'Cannot mix agent-path flags (--framework, --language, etc.) with harness-only flags (--model-id, --max-iterations, etc.)';
        if (opts.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          console.error(error);
        }
        process.exit(1);
      }

      // --no-agent: bare project (no harness, no agent)
      if (opts.agent === false) {
        opts.language = opts.language ?? 'Python';
        await handleCreateCLI(opts);
        return;
      }

      // Agent path: any agent-specific flag triggers it. CP volume-mount flags also route here
      // (without them, a lone --cp-volume-* would fall through to the harness path and be dropped
      // silently instead of hitting the "requires --capacity-provider" validation).
      const hasCpVolumeFlags = (opts.cpVolumeName?.length ?? 0) > 0 || (opts.cpVolumeMountPath?.length ?? 0) > 0;
      if (isAgentPath(opts) || hasCpVolumeFlags) {
        opts.language = opts.language ?? 'Python';
        await handleCreateCLI(opts);
        return;
      }

      // Harness path (default)
      if (!opts.json && !opts.modelProvider && !hasHarnessOnlyFlags(opts)) {
        console.log('Creating a harness project (pass --framework to create an agent project instead).');
      }
      await handleCreateHarnessCLI(opts);
    } catch (error) {
      render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
      process.exit(1);
    }
  });
};
