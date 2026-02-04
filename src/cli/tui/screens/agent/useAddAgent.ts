import { ConfigIO, NoProjectError, findConfigRoot, setEnvVar } from '../../../../lib';
import type { AgentEnvSpec, DirectoryPath, FilePath } from '../../../../schema';
import { getErrorMessage } from '../../../errors';
import { type PythonSetupResult, setupPythonProject } from '../../../operations';
import {
  mapGenerateConfigToAgentEnvSpec,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../../../operations/agent/generate';
import { computeDefaultIdentityEnvVarName } from '../../../operations/identity/create-identity';
import { createRenderer } from '../../../templates';
import type { GenerateConfig } from '../generate/types';
import type { AddAgentConfig } from './types';
import { dirname, join } from 'path';
import { useCallback, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AddAgentCreateResult {
  ok: true;
  type: 'create';
  agentName: string;
  projectPath: string;
  pythonSetupResult?: PythonSetupResult;
}

export interface AddAgentByoResult {
  ok: true;
  type: 'byo';
  agentName: string;
}

export interface AddAgentError {
  ok: false;
  error: string;
}

export type AddAgentOutcome = AddAgentCreateResult | AddAgentByoResult | AddAgentError;

// ─────────────────────────────────────────────────────────────────────────────
// Config Mappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps AddAgentConfig (from BYO wizard) to AgentEnvSpec for schema persistence.
 *
 * Unlike the create flow, this does NOT generate template files.
 * It only creates the schema entry pointing to existing code.
 */
export function mapByoConfigToAgentEnvSpec(config: AddAgentConfig, projectName: string): AgentEnvSpec {
  return {
    name: config.name,
    id: `${config.name}Agent`,
    sdkFramework: config.framework,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    runtime: {
      artifact: 'CodeZip',
      name: config.name,
      entrypoint: config.entrypoint as FilePath,
      codeLocation: config.codeLocation as DirectoryPath,
      pythonVersion: config.pythonVersion,
      networkMode: 'PUBLIC',
    },
    mcpProviders: [],
    memoryProviders: [],
    identityProviders: mapModelProviderToIdentityProviders(config.modelProvider, projectName),
    remoteTools: [],
  };
}

/**
 * Maps AddAgentConfig to GenerateConfig for the create path.
 */
function mapAddAgentConfigToGenerateConfig(config: AddAgentConfig): GenerateConfig {
  return {
    projectName: config.name, // In create context, this is the agent name
    sdk: config.framework,
    modelProvider: config.modelProvider,
    memory: config.memory,
    language: config.language,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to add an agent to the project.
 * Supports both "create" (generate from template) and "byo" (bring your own code) paths.
 */
export function useAddAgent() {
  const [isLoading, setIsLoading] = useState(false);

  const addAgent = useCallback(async (config: AddAgentConfig): Promise<AddAgentOutcome> => {
    setIsLoading(true);
    try {
      const configBaseDir = findConfigRoot();
      if (!configBaseDir) {
        return { ok: false, error: new NoProjectError().message };
      }

      const configIO = new ConfigIO({ baseDir: configBaseDir });

      if (!configIO.configExists('project')) {
        return { ok: false, error: new NoProjectError().message };
      }

      // Check for duplicate agent name
      const project = await configIO.readProjectSpec();
      const existingAgent = project.agents.find(agent => agent.name === config.name);
      if (existingAgent) {
        return { ok: false, error: `Agent "${config.name}" already exists in this project.` };
      }

      // Branch based on agent type
      if (config.agentType === 'create') {
        return await handleCreatePath(config, configBaseDir);
      } else {
        return await handleByoPath(config, configIO, configBaseDir);
      }
    } catch (err) {
      return { ok: false, error: getErrorMessage(err) };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setIsLoading(false);
  }, []);

  return { addAgent, isLoading, reset };
}

/**
 * Handle the "create" path: generate agent from template and write to project.
 */
async function handleCreatePath(
  config: AddAgentConfig,
  configBaseDir: string
): Promise<AddAgentCreateResult | AddAgentError> {
  // configBaseDir is the agentcore/ directory, project root is its parent
  const projectRoot = dirname(configBaseDir);

  const generateConfig = mapAddAgentConfigToGenerateConfig(config);
  const agentPath = join(projectRoot, config.name);

  // Generate agent files
  const agentSpec = mapGenerateConfigToAgentEnvSpec(generateConfig);
  const renderer = createRenderer(agentSpec);
  await renderer.render({ outputDir: projectRoot });

  // Write agent to project config
  await writeAgentToProject(generateConfig, { configBaseDir });

  // Set up Python environment if applicable
  let pythonSetupResult: PythonSetupResult | undefined;
  if (config.language === 'Python') {
    pythonSetupResult = await setupPythonProject({ projectDir: agentPath });
  }

  // Write API key to agentcore/.env for non-Bedrock providers
  if (config.apiKey && config.modelProvider !== 'Bedrock') {
    const envVarName = computeDefaultIdentityEnvVarName(config.modelProvider);
    await setEnvVar(envVarName, config.apiKey, configBaseDir);
  }

  return {
    ok: true,
    type: 'create',
    agentName: config.name,
    projectPath: agentPath,
    pythonSetupResult,
  };
}

/**
 * Handle the "byo" path: just write config to project (no file generation).
 */
async function handleByoPath(
  config: AddAgentConfig,
  configIO: ConfigIO,
  configBaseDir: string
): Promise<AddAgentByoResult | AddAgentError> {
  // Read project first to get project name for qualified identity provider names
  const project = await configIO.readProjectSpec();
  const agentEnvSpec = mapByoConfigToAgentEnvSpec(config, project.name);

  // Append new agent
  project.agents.push(agentEnvSpec);

  // Write updated project
  await configIO.writeProjectSpec(project);

  // Write API key to agentcore/.env for non-Bedrock providers
  if (config.apiKey && config.modelProvider !== 'Bedrock') {
    const envVarName = computeDefaultIdentityEnvVarName(config.modelProvider);
    await setEnvVar(envVarName, config.apiKey, configBaseDir);
  }

  return { ok: true, type: 'byo', agentName: config.name };
}
