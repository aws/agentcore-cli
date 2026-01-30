import { APP_DIR, CONFIG_DIR, ConfigIO, setEnvVar, setSessionProjectRoot } from '../../../lib';
import type {
  AgentCoreCliMcpDefs,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  DeployedState,
  ModelProvider,
  SDKFramework,
  TargetLanguage,
} from '../../../schema';
import { getErrorMessage } from '../../errors';
import { initGitRepo, setupPythonProject, writeEnvFile, writeGitignore } from '../../operations';
import { mapGenerateConfigToAgentEnvSpec, writeAgentToProject } from '../../operations/agent/generate';
import { CDKRenderer, createRenderer } from '../../templates';
import type { CreateResult } from './types';
import { mkdir } from 'fs/promises';
import { join } from 'path';

function createDefaultProjectSpec(projectName: string): AgentCoreProjectSpec {
  return {
    name: projectName,
    version: '0.1',
    description: `AgentCore project: ${projectName}`,
    agents: [],
  };
}

function createDefaultDeployedState(): DeployedState {
  return { targets: {} };
}

function createDefaultMcpSpec(): AgentCoreMcpSpec {
  return { agentCoreGateways: [], mcpRuntimeTools: [] };
}

function createDefaultMcpDefs(): AgentCoreCliMcpDefs {
  return { tools: {} };
}

export interface CreateProjectOptions {
  name: string;
  cwd: string;
  skipGit?: boolean;
}

export async function createProject(options: CreateProjectOptions): Promise<CreateResult> {
  const { name, cwd, skipGit } = options;
  const projectRoot = join(cwd, name);
  const configBaseDir = join(projectRoot, CONFIG_DIR);

  try {
    // Create project directory
    await mkdir(projectRoot, { recursive: true });

    // Initialize config directory
    const configIO = new ConfigIO({ baseDir: configBaseDir });
    await configIO.initializeBaseDir();

    setSessionProjectRoot(projectRoot);

    // Create config files
    await writeGitignore(configBaseDir);
    await writeEnvFile(configBaseDir);
    await configIO.writeProjectSpec(createDefaultProjectSpec(name));
    await configIO.writeAWSDeploymentTargets([]);
    await configIO.writeDeployedState(createDefaultDeployedState());
    await configIO.writeMcpSpec(createDefaultMcpSpec());
    await configIO.writeMcpDefs(createDefaultMcpDefs());

    // Create CDK project
    const cdkRenderer = new CDKRenderer();
    await cdkRenderer.render({ projectRoot });

    // Initialize git (unless skipped)
    if (!skipGit) {
      const gitResult = await initGitRepo(projectRoot);
      if (gitResult.status === 'error') {
        return { success: false, error: gitResult.message };
      }
    }

    return { success: true, projectPath: projectRoot };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
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
}

export async function createProjectWithAgent(options: CreateWithAgentOptions): Promise<CreateResult> {
  const { name, cwd, language, framework, modelProvider, apiKey, memory, skipGit, skipPythonSetup } = options;
  const projectRoot = join(cwd, name);
  const configBaseDir = join(projectRoot, CONFIG_DIR);

  // First create the base project
  const projectResult = await createProject({ name, cwd, skipGit });
  if (!projectResult.success) {
    return projectResult;
  }

  try {
    // Build GenerateConfig for agent creation
    const generateConfig = {
      projectName: name,
      sdk: framework,
      modelProvider,
      apiKey,
      memory,
      language,
    };

    // Generate agent code
    const agentSpec = mapGenerateConfigToAgentEnvSpec(generateConfig);
    const renderer = createRenderer(agentSpec);
    await renderer.render({ outputDir: projectRoot });
    await writeAgentToProject(generateConfig, { configBaseDir });

    // Store API key for non-Bedrock providers
    if (apiKey && modelProvider !== 'Bedrock') {
      const envVarName = `AGENTCORE_IDENTITY_${modelProvider.toUpperCase()}`;
      await setEnvVar(envVarName, apiKey, configBaseDir);
    }

    // Set up Python environment if needed (unless skipped)
    if (language === 'Python' && !skipPythonSetup) {
      const agentDir = join(projectRoot, APP_DIR, name);
      await setupPythonProject({ projectDir: agentDir });
    }

    return { success: true, projectPath: projectRoot, agentName: name };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
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
