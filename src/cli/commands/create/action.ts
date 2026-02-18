import { APP_DIR, CONFIG_DIR, ConfigIO, setEnvVar, setSessionProjectRoot } from '../../../lib';
import type { AgentCoreProjectSpec, DeployedState, ModelProvider, SDKFramework, TargetLanguage } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { checkCreateDependencies } from '../../external-requirements';
import { initGitRepo, setupPythonProject, writeEnvFile, writeGitignore } from '../../operations';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../../operations/agent/generate';
import { resolveCredentialStrategy } from '../../operations/identity/create-identity';
import { CDKRenderer, createRenderer } from '../../templates';
import type { CreateResult } from './types';
import { mkdir } from 'fs/promises';
import { join } from 'path';

function createDefaultProjectSpec(projectName: string): AgentCoreProjectSpec {
  return {
    name: projectName,
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };
}

function createDefaultDeployedState(): DeployedState {
  return { targets: {} };
}

export type ProgressCallback = (step: string, status: 'start' | 'done' | 'error') => void;

export interface CreateProjectOptions {
  name: string;
  cwd: string;
  skipGit?: boolean;
  skipDependencyCheck?: boolean;
  onProgress?: ProgressCallback;
}

export async function createProject(options: CreateProjectOptions): Promise<CreateResult> {
  const { name, cwd, skipGit, skipDependencyCheck, onProgress } = options;
  const projectRoot = join(cwd, name);
  const configBaseDir = join(projectRoot, CONFIG_DIR);

  // Check CLI dependencies first (no language = skip uv check)
  let depWarnings: string[] = [];
  if (!skipDependencyCheck) {
    const depCheck = await checkCreateDependencies({ language: undefined });
    depWarnings = depCheck.warnings;

    // Fail on errors
    if (!depCheck.passed) {
      return { success: false, error: depCheck.errors.join('\n'), warnings: depWarnings };
    }
  }

  try {
    // Create project directory
    onProgress?.(`Create ${name}/ project directory`, 'start');

    await mkdir(projectRoot, { recursive: true });
    onProgress?.(`Create ${name}/ project directory`, 'done');

    // Initialize config directory
    onProgress?.('Prepare agentcore/ directory', 'start');
    const configIO = new ConfigIO({ baseDir: configBaseDir });
    await configIO.initializeBaseDir();

    setSessionProjectRoot(projectRoot);

    // Create config files
    await writeGitignore(configBaseDir);
    await writeEnvFile(configBaseDir);
    await configIO.writeProjectSpec(createDefaultProjectSpec(name));
    await configIO.writeAWSDeploymentTargets([]);
    await configIO.writeDeployedState(createDefaultDeployedState());

    // Create CDK project
    const cdkRenderer = new CDKRenderer();
    await cdkRenderer.render({ projectRoot });
    onProgress?.('Prepare agentcore/ directory', 'done');

    // Initialize git (unless skipped)
    if (!skipGit) {
      onProgress?.('Initialize git repository', 'start');
      const gitResult = await initGitRepo(projectRoot);
      if (gitResult.status === 'error') {
        onProgress?.('Initialize git repository', 'error');
        return { success: false, error: gitResult.message, warnings: depWarnings };
      }
      onProgress?.('Initialize git repository', 'done');
    }

    return {
      success: true,
      projectPath: projectRoot,
      warnings: depWarnings.length > 0 ? depWarnings : undefined,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err), warnings: depWarnings };
  }
}

type MemoryOption = 'none' | 'shortTerm' | 'longAndShortTerm';

export interface CreateWithAgentOptions {
  name: string;
  cwd: string;
  language: TargetLanguage;
  framework: SDKFramework;
  modelProvider: ModelProvider;
  apiKey?: string;
  memory: MemoryOption;
  skipGit?: boolean;
  skipPythonSetup?: boolean;
  onProgress?: ProgressCallback;
}

export async function createProjectWithAgent(options: CreateWithAgentOptions): Promise<CreateResult> {
  const { name, cwd, language, framework, modelProvider, apiKey, memory, skipGit, skipPythonSetup, onProgress } =
    options;
  const projectRoot = join(cwd, name);
  const configBaseDir = join(projectRoot, CONFIG_DIR);

  // Check CLI dependencies first (with language for conditional uv check)
  const depCheck = await checkCreateDependencies({ language });
  const depWarnings = depCheck.warnings;

  // Fail on errors
  if (!depCheck.passed) {
    return { success: false, error: depCheck.errors.join('\n'), warnings: depWarnings };
  }

  // First create the base project (skip dependency check since we already did it)
  const projectResult = await createProject({ name, cwd, skipGit, skipDependencyCheck: true, onProgress });
  if (!projectResult.success) {
    // Merge warnings from both checks
    const allWarnings = [...depWarnings, ...(projectResult.warnings ?? [])];
    return { ...projectResult, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  }

  try {
    // Build GenerateConfig for agent creation
    // Note: In this context, agent name = project name since we're creating a project with a single agent
    onProgress?.('Add agent to project', 'start');
    const agentName = name;
    const generateConfig = {
      projectName: agentName,
      sdk: framework,
      modelProvider,
      apiKey,
      memory,
      language,
    };

    // Resolve credential strategy FIRST (new project has no existing credentials)
    let identityProviders: ReturnType<typeof mapModelProviderToIdentityProviders> = [];
    let strategy: Awaited<ReturnType<typeof resolveCredentialStrategy>> | undefined;

    if (modelProvider !== 'Bedrock') {
      strategy = await resolveCredentialStrategy(
        name,
        agentName,
        modelProvider,
        apiKey,
        configBaseDir,
        [] // New project has no existing credentials
      );

      identityProviders = [
        {
          name: strategy.credentialName,
          envVarName: strategy.envVarName,
        },
      ];
    }

    // Generate agent code with correct identity provider
    const renderConfig = mapGenerateConfigToRenderConfig(generateConfig, identityProviders);
    const renderer = createRenderer(renderConfig);
    await renderer.render({ outputDir: projectRoot });

    // Write agent to project config
    if (strategy) {
      await writeAgentToProject(generateConfig, { configBaseDir, credentialStrategy: strategy });

      if (apiKey) {
        await setEnvVar(strategy.envVarName, apiKey, configBaseDir);
      }
    } else {
      await writeAgentToProject(generateConfig, { configBaseDir });
    }
    onProgress?.('Add agent to project', 'done');

    // Set up Python environment if needed (unless skipped)
    if (language === 'Python' && !skipPythonSetup) {
      onProgress?.('Set up Python environment', 'start');
      const agentDir = join(projectRoot, APP_DIR, name);
      await setupPythonProject({ projectDir: agentDir });
      onProgress?.('Set up Python environment', 'done');
    }

    return {
      success: true,
      projectPath: projectRoot,
      agentName: name,
      warnings: depWarnings.length > 0 ? depWarnings : undefined,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err), warnings: depWarnings };
  }
}

export function getDryRunInfo(options: { name: string; cwd: string; language?: string }): CreateResult {
  const { name, cwd, language } = options;
  const projectRoot = join(cwd, name);

  const wouldCreate = [
    `${projectRoot}/`,
    `${projectRoot}/agentcore/`,
    `${projectRoot}/agentcore/project.json`,
    `${projectRoot}/agentcore/aws-targets.json`,
    `${projectRoot}/agentcore/.env.local`,
    `${projectRoot}/cdk/`,
  ];

  if (language === 'Python') {
    wouldCreate.push(`${projectRoot}/app/${name}/`);
    wouldCreate.push(`${projectRoot}/app/${name}/main.py`);
    wouldCreate.push(`${projectRoot}/app/${name}/pyproject.toml`);
  }

  return {
    success: true,
    dryRun: true,
    projectPath: projectRoot,
    wouldCreate,
  };
}
