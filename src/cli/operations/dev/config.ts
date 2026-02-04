import { ConfigIO, findConfigRoot } from '../../../lib';
import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../../schema';
import { dirname, isAbsolute, join } from 'node:path';

export interface DevConfig {
  agentName: string;
  module: string;
  directory: string;
  hasConfig: boolean;
  isPython: boolean;
}

interface DevSupportResult {
  supported: boolean;
  reason?: string;
}

/**
 * Checks if dev mode is supported for the given agent.
 *
 * Requirements:
 * - Agent must target Python (TypeScript support not yet implemented)
 * - CodeZip agents must have entrypoint
 */
function isDevSupported(agent: AgentEnvSpec): DevSupportResult {
  // Currently only Python is supported for dev mode
  // TODO: Add TypeScript support
  if (agent.targetLanguage !== 'Python') {
    return {
      supported: false,
      reason: `Dev mode only supports Python agents. Agent "${agent.name}" targets ${agent.targetLanguage}.`,
    };
  }

  if (!agent.runtime.entrypoint) {
    return {
      supported: false,
      reason: `Agent "${agent.name}" is missing entrypoint.`,
    };
  }

  return { supported: true };
}

/**
 * Resolves the agent's code directory from codeLocation.
 * codeLocation can be absolute or relative to the project root.
 */
function resolveCodeDirectory(codeLocation: string, configRoot: string): string {
  const cleanPath = codeLocation.replace(/\/$/, '');

  if (isAbsolute(cleanPath)) {
    return cleanPath;
  }

  const projectRoot = dirname(configRoot);
  return join(projectRoot, cleanPath);
}

/**
 * Returns a list of agents that support dev mode.
 */
export function getDevSupportedAgents(project: AgentCoreProjectSpec | null): AgentEnvSpec[] {
  if (!project?.agents) return [];
  return project.agents.filter(agent => isDevSupported(agent).supported);
}

/**
 * Get the port for a specific agent based on its index in the project.
 * Base port + agent index = actual port
 */
export function getAgentPort(project: AgentCoreProjectSpec | null, agentName: string, basePort: number): number {
  if (!project) return basePort;
  const index = project.agents.findIndex(a => a.name === agentName);
  return index >= 0 ? basePort + index : basePort;
}

/**
 * Derives dev server configuration from project config.
 * Falls back to sensible defaults if no config is available.
 * @param agentName - Optional agent name. If not provided, uses the first dev-supported agent.
 */
export function getDevConfig(
  workingDir: string,
  project: AgentCoreProjectSpec | null,
  configRoot?: string,
  agentName?: string
): DevConfig {
  if (!project) {
    throw new Error('No project configuration found');
  }

  // Find the target agent
  let targetAgent: AgentEnvSpec | undefined;
  if (agentName) {
    targetAgent = project.agents.find(a => a.name === agentName);
    if (!targetAgent) {
      throw new Error(`Agent "${agentName}" not found in project.`);
    }
  } else {
    // Default to first dev-supported agent
    const supportedAgents = getDevSupportedAgents(project);
    targetAgent = supportedAgents[0];
  }

  if (!targetAgent) {
    throw new Error('No dev-supported agents found. Dev mode requires Python agents.');
  }

  const supportResult = isDevSupported(targetAgent);
  if (!supportResult.supported) {
    throw new Error(supportResult.reason ?? 'Agent does not support dev mode');
  }

  const directory =
    configRoot && targetAgent.runtime.codeLocation
      ? resolveCodeDirectory(targetAgent.runtime.codeLocation, configRoot)
      : workingDir;

  return {
    agentName: targetAgent.name,
    module: targetAgent.runtime.entrypoint,
    directory,
    hasConfig: true,
    isPython: targetAgent.targetLanguage === 'Python',
  };
}

/**
 * Loads project configuration from the agentcore directory.
 * Walks up from workingDir to find the agentcore config directory.
 * Returns null if config doesn't exist or is invalid.
 */
export async function loadProjectConfig(workingDir: string): Promise<AgentCoreProjectSpec | null> {
  const configRoot = findConfigRoot(workingDir);
  if (!configRoot) {
    return null;
  }

  const configIO = new ConfigIO({ baseDir: configRoot });

  if (!configIO.configExists('project')) {
    return null;
  }

  try {
    return await configIO.readProjectSpec();
  } catch {
    // Invalid config
    return null;
  }
}
