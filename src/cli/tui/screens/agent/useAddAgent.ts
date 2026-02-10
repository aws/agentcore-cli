import { ConfigIO, NoProjectError, findConfigRoot, setEnvVar } from '../../../../lib';
import type { AgentEnvSpec, DirectoryPath, FilePath } from '../../../../schema';
import { getErrorMessage } from '../../../errors';
import { type PythonSetupResult, setupPythonProject } from '../../../operations';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../../../operations/agent/generate';
import {
  computeDefaultCredentialEnvVarName,
  resolveCredentialStrategy,
} from '../../../operations/identity/create-identity';
import { createRenderer } from '../../../templates';
import type { GenerateConfig } from '../generate/types';
import type { AddAgentConfig } from './types';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { useCallback, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AddAgentCreateResult {
  ok: true;
  type: 'create';
  agentName: string;
  projectName: string;
  projectPath: string;
  pythonSetupResult?: PythonSetupResult;
}

export interface AddAgentByoResult {
  ok: true;
  type: 'byo';
  agentName: string;
  projectName: string;
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
 * Maps AddAgentConfig (from BYO wizard) to v2 AgentEnvSpec for schema persistence.
 */
export function mapByoConfigToAgent(config: AddAgentConfig): AgentEnvSpec {
  return {
    type: 'AgentCoreRuntime',
    name: config.name,
    build: 'CodeZip',
    entrypoint: config.entrypoint as FilePath,
    codeLocation: config.codeLocation as DirectoryPath,
    runtimeVersion: config.pythonVersion,
    networkMode: 'PUBLIC',
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
  const configIO = new ConfigIO({ baseDir: configBaseDir });
  const project = await configIO.readProjectSpec();

  const generateConfig = mapAddAgentConfigToGenerateConfig(config);
  const agentPath = join(projectRoot, config.name);

  // Resolve credential strategy FIRST to determine correct credential name
  let identityProviders: ReturnType<typeof mapModelProviderToIdentityProviders> = [];
  let strategy: Awaited<ReturnType<typeof resolveCredentialStrategy>> | undefined;

  if (config.modelProvider !== 'Bedrock') {
    strategy = await resolveCredentialStrategy(
      project.name,
      config.name,
      config.modelProvider,
      config.apiKey,
      configBaseDir,
      project.credentials
    );

    // Build identity providers with the correct credential name from strategy
    identityProviders = [
      {
        name: strategy.credentialName,
        envVarName: strategy.envVarName,
      },
    ];
  }

  // Generate agent files with correct identity provider
  const renderConfig = mapGenerateConfigToRenderConfig(generateConfig, identityProviders);
  const renderer = createRenderer(renderConfig);
  await renderer.render({ outputDir: projectRoot });

  // Write agent to project config
  if (strategy) {
    await writeAgentToProject(generateConfig, { configBaseDir, credentialStrategy: strategy });

    // Always write env var (empty if skipped) so users can easily find and fill it in
    // Use project-scoped name if strategy returned empty (no API key case)
    const envVarName =
      strategy.envVarName || computeDefaultCredentialEnvVarName(`${project.name}${config.modelProvider}`);
    await setEnvVar(envVarName, config.apiKey ?? '', configBaseDir);
  } else {
    // Bedrock: no credentials needed
    await writeAgentToProject(generateConfig, { configBaseDir });
  }

  // Set up Python environment if applicable
  let pythonSetupResult: PythonSetupResult | undefined;
  if (config.language === 'Python') {
    pythonSetupResult = await setupPythonProject({ projectDir: agentPath });
  }

  return {
    ok: true,
    type: 'create',
    agentName: config.name,
    projectName: project.name,
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
  // Ensure the code folder exists (create if it doesn't)
  const projectRoot = dirname(configBaseDir);
  const codeDir = join(projectRoot, config.codeLocation.replace(/\/$/, ''));
  mkdirSync(codeDir, { recursive: true });

  const project = await configIO.readProjectSpec();
  const agent = mapByoConfigToAgent(config);

  // Append new agent
  project.agents.push(agent);

  // Handle credential creation with smart reuse detection
  if (config.modelProvider !== 'Bedrock') {
    const strategy = await resolveCredentialStrategy(
      project.name,
      config.name,
      config.modelProvider,
      config.apiKey,
      configBaseDir,
      project.credentials
    );

    if (!strategy.reuse) {
      const credentials = mapModelProviderToCredentials(config.modelProvider, project.name);
      if (credentials.length > 0) {
        credentials[0]!.name = strategy.credentialName;
        project.credentials.push(...credentials);
      }
    }

    // Write updated project
    await configIO.writeProjectSpec(project);

    // Always write env var (empty if skipped) so users can easily find and fill it in
    // Use project-scoped name if strategy returned empty (no API key case)
    const envVarName =
      strategy.envVarName || computeDefaultCredentialEnvVarName(`${project.name}${config.modelProvider}`);
    await setEnvVar(envVarName, config.apiKey ?? '', configBaseDir);
  } else {
    // Bedrock: no credentials needed
    await configIO.writeProjectSpec(project);
  }

  return { ok: true, type: 'byo', agentName: config.name, projectName: project.name };
}
