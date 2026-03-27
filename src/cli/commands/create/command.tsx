import { getWorkingDirectory } from '../../../lib';
import type {
  BuildType,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  SDKFramework,
  TargetLanguage,
} from '../../../schema';
import { LIFECYCLE_TIMEOUT_MAX, LIFECYCLE_TIMEOUT_MIN } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { CreateScreen } from '../../tui/screens/create';
import { parseCommaSeparatedList } from '../shared/vpc-utils';
import { type ProgressCallback, createProject, createProjectWithAgent, getDryRunInfo } from './action';
import type { CreateOptions } from './types';
import { validateCreateOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

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

/** Handle CLI mode with progress output */
async function handleCreateCLI(options: CreateOptions): Promise<void> {
  const cwd = options.outputDir ?? getWorkingDirectory();

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
    const result = getDryRunInfo({ name: options.name!, cwd, language: options.language });
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
    ? await createProject({ name: options.name!, cwd, skipGit: options.skipGit, onProgress })
    : await createProjectWithAgent({
        name: options.name!,
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
        skipGit: options.skipGit,
        skipPythonSetup: options.skipPythonSetup,
        onProgress,
      });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    printCreateSummary(options.name!, result.agentName, options.language, options.framework);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export const registerCreate = (program: Command) => {
  program
    .command('create')
    .description(COMMAND_DESCRIPTIONS.create)
    .option('--name <name>', 'Project name (start with letter, alphanumeric only, max 23 chars) [non-interactive]')
    .option('--no-agent', 'Skip agent creation [non-interactive]')
    .option('--defaults', 'Use defaults (Python, Strands, Bedrock, no memory) [non-interactive]')
    .option('--build <type>', 'Build type: CodeZip or Container (default: CodeZip) [non-interactive]')
    .option('--language <language>', 'Target language (default: Python) [non-interactive]')
    .option(
      '--framework <framework>',
      'Agent framework (Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents) [non-interactive]'
    )
    .option('--model-provider <provider>', 'Model provider (Bedrock, Anthropic, OpenAI, Gemini) [non-interactive]')
    .option('--api-key <key>', 'API key for non-Bedrock providers [non-interactive]')
    .option('--memory <option>', 'Memory option (none, shortTerm, longAndShortTerm) [non-interactive]')
    .option('--protocol <protocol>', 'Protocol: HTTP, MCP, A2A (default: HTTP) [non-interactive]')
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
    .option('--output-dir <dir>', 'Output directory (default: current directory) [non-interactive]')
    .option('--skip-git', 'Skip git repository initialization [non-interactive]')
    .option('--skip-python-setup', 'Skip Python virtual environment setup [non-interactive]')
    .option('--dry-run', 'Preview what would be created without making changes [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async options => {
      try {
        // Apply defaults if --defaults flag is set
        if (options.defaults) {
          options.language = options.language ?? 'Python';
          options.build = options.build ?? 'CodeZip';
          options.framework = options.framework ?? 'Strands';
          options.modelProvider = options.modelProvider ?? 'Bedrock';
          options.memory = options.memory ?? 'none';
        }

        // Any flag triggers non-interactive CLI mode
        const hasAnyFlag = Boolean(
          options.name ??
          (options.agent === false ? true : null) ??
          options.defaults ??
          options.build ??
          options.language ??
          options.framework ??
          options.modelProvider ??
          options.apiKey ??
          options.memory ??
          options.outputDir ??
          options.skipGit ??
          options.skipPythonSetup ??
          options.dryRun ??
          options.json
        );

        if (hasAnyFlag) {
          // Default language to Python (only supported option) for CLI mode
          options.language = options.language ?? 'Python';
          await handleCreateCLI(options as CreateOptions);
        } else {
          handleCreateTUI();
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
