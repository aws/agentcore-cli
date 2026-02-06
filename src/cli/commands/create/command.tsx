import { getWorkingDirectory } from '../../../lib';
import type { ModelProvider, SDKFramework, TargetLanguage } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { CreateScreen } from '../../tui/screens/create';
import { createProject, createProjectWithAgent, getDryRunInfo } from './action';
import type { CreateOptions } from './types';
import { validateCreateOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

function handleCreateTUI(): void {
  const cwd = getWorkingDirectory();
  const { unmount } = render(<CreateScreen cwd={cwd} isInteractive={false} onExit={() => unmount()} />);
}

/** Print CLI completion output with progress and next steps */
function printCreateSuccess(
  projectName: string,
  projectPath: string,
  agentName: string | undefined,
  language: string | undefined,
  framework: string | undefined
): void {
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log('');
  console.log(`${green}[done]${reset}  Create ${projectName}/ project directory`);
  if (agentName) {
    console.log(`${green}[done]${reset}  Add agent to project`);
    if (language === 'Python') {
      console.log(`${green}[done]${reset}  Set up Python environment`);
    }
  }
  console.log(`${green}[done]${reset}  Prepare agentcore/ directory`);
  console.log(`${green}[done]${reset}  Initialize git repository`);
  console.log('');

  // Created summary
  console.log(`${dim}Created:${reset}`);
  console.log(`  ${projectName}/`);
  if (agentName) {
    const frameworkLabel = framework ?? 'agent';
    console.log(`    app/${agentName}/  ${dim}${language} agent (${frameworkLabel})${reset}`);
  }
  console.log(`    agentcore/           ${dim}Config and CDK project${reset}`);
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

async function handleCreateCLI(options: CreateOptions): Promise<void> {
  const validation = validateCreateOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const cwd = options.outputDir ?? getWorkingDirectory();

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

  // Commander.js --no-agent sets agent=false, not noAgent=true
  const skipAgent = options.agent === false;

  const result = skipAgent
    ? await createProject({ name: options.name!, cwd, skipGit: options.skipGit })
    : await createProjectWithAgent({
        name: options.name!,
        cwd,
        language: options.language as TargetLanguage,
        framework: options.framework as SDKFramework,
        modelProvider: options.modelProvider as ModelProvider,
        apiKey: options.apiKey,
        memory: options.memory as 'none' | 'shortTerm' | 'longAndShortTerm',
        skipGit: options.skipGit,
        skipPythonSetup: options.skipPythonSetup,
      });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    printCreateSuccess(options.name!, result.projectPath!, result.agentName, options.language, options.framework);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export const registerCreate = (program: Command) => {
  program
    .command('create')
    .description(COMMAND_DESCRIPTIONS.create)
    .option('--name <name>', 'Project name (start with letter, alphanumeric only, max 36 chars)')
    .option('--no-agent', 'Skip agent creation')
    .option('--defaults', 'Use defaults (Python, Strands, Bedrock, no memory)')
    .option('--language <language>', 'Target language (Python, TypeScript)')
    .option(
      '--framework <framework>',
      'Agent framework (Strands, LangChain_LangGraph, AutoGen, CrewAI, GoogleADK, OpenAIAgents)'
    )
    .option('--model-provider <provider>', 'Model provider (Bedrock, Anthropic, OpenAI, Gemini)')
    .option('--api-key <key>', 'API key for non-Bedrock providers')
    .option('--memory <option>', 'Memory option (none, shortTerm, longAndShortTerm)')
    .option('--output-dir <dir>', 'Output directory (default: current directory)')
    .option('--skip-git', 'Skip git repository initialization')
    .option('--skip-python-setup', 'Skip Python virtual environment setup')
    .option('--dry-run', 'Preview what would be created without making changes')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        // Apply defaults if --defaults flag is set
        if (options.defaults) {
          options.language = options.language ?? 'Python';
          options.framework = options.framework ?? 'Strands';
          options.modelProvider = options.modelProvider ?? 'Bedrock';
          options.memory = options.memory ?? 'none';
        }

        if (options.name) {
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
