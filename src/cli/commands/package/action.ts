import {
  CONFIG_DIR,
  ConfigIO,
  packCodeZipSync,
  packRuntime,
  resolveCodeLocation,
  validateAgentExists,
} from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
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

  for (const agent of agentsToPackage) {
    if (agent.build === 'CodeZip') {
      // Existing CodeZip packaging
      const codeLocation = resolveCodeLocation(agent.codeLocation, configBaseDir);
      const { artifactPath, sizeBytes } = packCodeZipSync(agent, {
        projectRoot: codeLocation,
        agentName: agent.name,
        artifactDir: configBaseDir,
      });
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
      results.push({ agentName: agent.name, artifactPath, sizeMb });
    } else if (agent.build === 'Container') {
      // Container packaging via ContainerPackager
      const result = await packRuntime(agent, {
        agentName: agent.name,
        artifactDir: configBaseDir,
      });

      if (!result.artifactPath) {
        // No container runtime available — skipped local build validation
        console.warn('No container runtime found. Skipping local build validation. Deploy will use CodeBuild.');
        skipped.push(agent.name);
      } else {
        const sizeMb = (result.sizeBytes / (1024 * 1024)).toFixed(2);
        results.push({ agentName: agent.name, artifactPath: result.artifactPath, sizeMb });
      }
    }
  }

  return { success: true, results, skipped };
}
