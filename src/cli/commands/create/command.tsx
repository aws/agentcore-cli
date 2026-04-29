import { getWorkingDirectory } from '../../../lib';
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
import { getErrorMessage } from '../../errors';
import { harnessPrimitive } from '../../primitives/registry';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireTTY } from '../../tui/guards';
import { CreateScreen } from '../../tui/screens/create';
import { parseCommaSeparatedList } from '../shared/vpc-utils';
import { type ProgressCallback, createProject, createProjectWithAgent, getDryRunInfo } from './action';
import { createProjectWithHarness } from './harness-action';
import { normalizeHarnessModelProvider, validateCreateHarnessOptions } from './harness-validate';
import type { CreateOptions } from './types';
import { validateCreateOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

/** Flags that trigger the agent/runtime path */
const AGENT_PATH_FLAGS = ['framework', 'language', 'build', 'protocol', 'type', 'agentId', 'agentAliasId'] as const;

/** Flags that are harness-only */
const HARNESS_ONLY_FLAGS = [
  'modelId',
  'apiKeyArn',
  'maxIterations',
  'maxTokens',
  'timeout',
  'truncationStrategy',
] as const;

/** Determines if the agent path should be taken based on provided flags */
function isAgentPath(options: CreateOptions): boolean {
  return AGENT_PATH_FLAGS.some(flag => options[flag] !== undefined);
}

/** Determines if any harness-only flags are present */
function hasHarnessOnlyFlags(options: CreateOptions): boolean {
  return HARNESS_ONLY_FLAGS.some(flag => options[flag] !== undefined);
}

/** Render CreateScreen for interactive TUI mode */
function handleCreateTUI(): void {
  const cwd = getWorkingDirectory();
  const { unmount } = render(
    <CreateScreen
      cwd={cwd}
      isInteractive={false}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />
  );
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
  const cwd = options.outputDir ?? getWorkingDirectory();
  const name = options.name ?? options.projectName;
  const projectName = options.projectName ?? name;

  const validation = validateCreateHarnessOptions(
    {
      name,
      projectName,
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      apiKeyArn: options.apiKeyArn,
    },
    cwd
  );
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  // Progress callback
  const green = '\x1b[32m';
  const reset = '\x1b[0m';
  const onProgress: ProgressCallback | undefined = options.json
    ? undefined
    : (step, status) => {
        if (status === 'done') console.log(`${green}[done]${reset}  ${step}`);
        else if (status === 'error') console.log(`\x1b[31m[error]${reset} ${step}`);
      };

  const provider = (
    options.modelProvider ? normalizeHarnessModelProvider(options.modelProvider) : 'bedrock'
  ) as HarnessModelProvider;
  const defaultModelIds: Record<string, string> = {
    bedrock: 'global.anthropic.claude-sonnet-4-6',
    open_ai: 'gpt-5',
    gemini: 'gemini-2.5-flash',
  };
  const modelId = options.modelId ?? defaultModelIds[provider] ?? 'global.anthropic.claude-sonnet-4-6';

  const containerOption = harnessPrimitive.parseContainerFlag(options.container);

  const result = await createProjectWithHarness({
    name: name!,
    projectName: projectName!,
    cwd,
    modelProvider: provider,
    modelId,
    apiKeyArn: options.apiKeyArn,
    containerUri: containerOption.containerUri,
    dockerfilePath: containerOption.dockerfilePath,
    skipMemory: options.harnessMemory === false,
    maxIterations: options.maxIterations ? Number(options.maxIterations) : undefined,
    maxTokens: options.maxTokens ? Number(options.maxTokens) : undefined,
    timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
    truncationStrategy: options.truncationStrategy as 'sliding_window' | 'summarization' | undefined,
    networkMode: options.networkMode as NetworkMode | undefined,
    subnets: parseCommaSeparatedList(options.subnets),
    securityGroups: parseCommaSeparatedList(options.securityGroups),
    idleTimeout: options.idleTimeout ? Number(options.idleTimeout) : undefined,
    maxLifetime: options.maxLifetime ? Number(options.maxLifetime) : undefined,
    sessionStoragePath: options.sessionStorageMountPath,
    skipGit: options.skipGit,
    skipInstall: options.skipInstall,
    onProgress,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    printCreateHarnessSummary(projectName!, name!);
  } else {
    console.error(result.error);
  }
  process.exit(result.success ? 0 : 1);
}

/** Handle CLI mode with progress output for the agent/runtime path */
async function handleCreateAgentCLI(options: CreateOptions): Promise<void> {
  const cwd = options.outputDir ?? getWorkingDirectory();
  const name = options.name ?? options.projectName;
  const projectName = options.projectName ?? name;

  const validation = validateCreateOptions(options, cwd);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  // Handle dry-run mode
  if (options.dryRun) {
    const result = getDryRunInfo({ name: name!, projectName: projectName!, cwd, language: options.language });
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log('Dry run - would create:');
      for (const path of result.wouldCreate ?? []) {
        console.log(`  ${path}`);
      }
    }
    process.exit(0);
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
        projectName: projectName!,
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
        idleTimeout: options.idleTimeout ? Number(options.idleTimeout) : undefined,
        maxLifetime: options.maxLifetime ? Number(options.maxLifetime) : undefined,
        sessionStorageMountPath: options.sessionStorageMountPath,
        skipGit: options.skipGit,
        skipInstall: options.skipInstall,
        skipPythonSetup: options.skipPythonSetup,
        onProgress,
      });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    printCreateSummary(projectName!, result.agentName, options.language, options.framework);
    if (options.skipInstall) {
      console.log(
        "\nDependency installation was skipped. Run 'npm install' in agentcore/cdk/ and 'uv sync' in your agent directory manually."
      );
    }
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export const registerCreate = (program: Command) => {
  program
    .command('create')
    .description(COMMAND_DESCRIPTIONS.create)
    .option('--name <name>', 'Resource name (agent or harness) [non-interactive]')
    .option(
      '--project-name <name>',
      'Project name (start with letter, alphanumeric only, max 23 chars) [non-interactive]'
    )
    .option('--no-agent', 'Skip agent creation [non-interactive]')
    .option('--defaults', 'Use defaults [non-interactive]')
    .option('--build <type>', 'Build type: CodeZip or Container (default: CodeZip) [non-interactive]')
    .option('--language <language>', 'Target language (default: Python) [non-interactive]')
    .option(
      '--framework <framework>',
      'Agent framework (Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents); triggers agent/runtime path [non-interactive]'
    )
    .option('--model-provider <provider>', 'Model provider: bedrock, open_ai, gemini (harness path) [non-interactive]')
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
    .option('--output-dir <dir>', 'Output directory (default: current directory) [non-interactive]')
    .option('--skip-git', 'Skip git repository initialization [non-interactive]')
    .option('--skip-python-setup', 'Skip Python virtual environment setup [non-interactive]')
    .option('--skip-install', 'Skip all dependency installation (npm install, uv sync) [non-interactive]')
    .option('--dry-run', 'Preview what would be created without making changes [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .option('--model-id <id>', 'Model ID for harness [non-interactive]')
    .option('--api-key-arn <arn>', 'API key ARN for non-Bedrock harness providers [non-interactive]')
    .option('--no-harness-memory', 'Skip auto-creating memory for harness [non-interactive]')
    .option('--max-iterations <n>', 'Max agent loop iterations (harness) [non-interactive]')
    .option('--max-tokens <n>', 'Max tokens per iteration (harness) [non-interactive]')
    .option('--timeout <seconds>', 'Max execution duration in seconds (harness) [non-interactive]')
    .option(
      '--truncation-strategy <strategy>',
      'Truncation strategy: sliding_window or summarization (harness) [non-interactive]'
    )
    .option('--container <uri-or-path>', 'Container image URI or Dockerfile path (harness) [non-interactive]')
    .action(async options => {
      try {
        // Any flag triggers non-interactive CLI mode
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
          options.idleTimeout ??
          options.maxLifetime ??
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
          handleCreateTUI();
          return;
        }

        // CLI mode: fork between harness and agent paths
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
          await handleCreateAgentCLI(opts);
          return;
        }

        // Agent path: any agent-specific flag triggers it
        if (isAgentPath(opts)) {
          // Apply agent defaults if --defaults
          if (opts.defaults) {
            opts.language = opts.language ?? 'Python';
            opts.build = opts.build ?? 'CodeZip';
            opts.framework = opts.framework ?? 'Strands';
            opts.modelProvider = opts.modelProvider ?? 'Bedrock';
            opts.memory = opts.memory ?? 'none';
          }
          opts.language = opts.language ?? 'Python';
          await handleCreateAgentCLI(opts);
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
