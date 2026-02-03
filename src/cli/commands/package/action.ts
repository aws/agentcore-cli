import { CONFIG_DIR, ConfigIO, packRuntime, resolveCodeLocation, validateAgentExists } from '../../../lib';
import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../../schema';
import { join, resolve } from 'path';

export interface PackageOptions {
  directory?: string;
  agent?: string;
}

export interface PackageContext {
  project: AgentCoreProjectSpec;
  configBaseDir: string;
  projectRoot?: string;
  targetAgent?: string;
}

export async function loadPackageConfig(options: PackageOptions): Promise<PackageContext> {
  const projectRoot = options.directory ? resolve(options.directory) : undefined;
  const baseDir = projectRoot ? join(projectRoot, CONFIG_DIR) : undefined;
  const configIO = new ConfigIO(baseDir ? { baseDir } : undefined);

  return {
    project: await configIO.readProjectSpec(),
    configBaseDir: configIO.getPathResolver().getBaseDir(),
    projectRoot,
    targetAgent: options.agent,
  };
}

export interface PackageAgentResult {
  agentName: string;
  artifactPath: string;
  sizeMb: string;
}

export interface PackageResult {
  success: boolean;
  results: PackageAgentResult[];
  skipped: string[];
  error?: string;
}

export async function handlePackage(context: PackageContext): Promise<PackageResult> {
  const { project, configBaseDir, targetAgent } = context;
  const results: PackageAgentResult[] = [];
  const skipped: string[] = [];

  // Validate --agent flag if specified
  if (targetAgent) {
    validateAgentExists(project, targetAgent);
  }

  // Filter agents based on --agent flag
  const agentsToPackage = targetAgent ? project.agents.filter(a => a.name === targetAgent) : project.agents;

  // Type guard for CodeZip agents
  type CodeZipAgent = AgentEnvSpec & { runtime: { artifact: 'CodeZip' } };
  function isCodeZipAgent(agent: AgentEnvSpec): agent is CodeZipAgent {
    return agent.runtime.artifact === 'CodeZip';
  }

  // Filter only CodeZip artifacts
  const packableAgents: CodeZipAgent[] = [];
  for (const agent of agentsToPackage) {
    const agentName = agent.name;
    if (isCodeZipAgent(agent)) {
      packableAgents.push(agent);
    } else {
      skipped.push(agentName);
    }
  }

  if (packableAgents.length === 0) {
    return { success: true, results: [], skipped };
  }

  // Package each agent (fail-fast: throw on first error)
  for (const agent of packableAgents) {
    const codeLocation = resolveCodeLocation(agent.runtime.codeLocation, configBaseDir);

    // This will throw if packaging fails - satisfies fail-fast requirement
    const { artifactPath, sizeBytes } = await packRuntime(agent, {
      projectRoot: codeLocation,
      agentName: agent.name,
      artifactDir: configBaseDir,
    });

    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    results.push({ agentName: agent.name, artifactPath, sizeMb });
  }

  return { success: true, results, skipped };
}
