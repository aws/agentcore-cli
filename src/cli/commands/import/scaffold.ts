import { APP_DIR, CONFIG_DIR, CONFIG_FILES, ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AgentEnvSpec, AwsDeploymentTarget, Memory } from '../../../schema';
import { SCHEMA_VERSION } from '../../constants';
import { CDKRenderer } from '../../templates';
import type { ParsedStarterToolkitConfig } from './types';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Convert parsed starter toolkit agents to CLI AgentEnvSpec format.
 */
function toAgentEnvSpec(
  agent: ParsedStarterToolkitConfig['agents'][0],
  projectRoot: string
): AgentEnvSpec {
  // Always use the standard app/<name> location.
  // The user should copy their agent source code to app/<name>/ before deploying.
  const codeLocation = path.join(APP_DIR, agent.name);

  // The entrypoint from the starter toolkit may be an absolute path.
  // The CLI expects just the filename (e.g., "main.py" or "main.py:handler").
  const entrypoint = path.basename(agent.entrypoint);

  const spec: AgentEnvSpec = {
    type: 'AgentCoreRuntime',
    name: agent.name,
    build: agent.build,
    entrypoint: entrypoint as any,
    codeLocation: codeLocation as any,
    runtimeVersion: (agent.runtimeVersion ?? 'PYTHON_3_12') as any,
    protocol: agent.protocol,
    networkMode: agent.networkMode,
    instrumentation: { enableOtel: agent.enableOtel },
  };

  if (agent.networkMode === 'VPC' && agent.networkConfig) {
    spec.networkConfig = agent.networkConfig;
  }

  return spec;
}

/**
 * Convert parsed starter toolkit memory to CLI Memory format.
 */
function toMemorySpec(mem: ParsedStarterToolkitConfig['memories'][0]): Memory {
  const strategies: Memory['strategies'] = [];

  if (mem.mode === 'STM_ONLY' || mem.mode === 'STM_AND_LTM') {
    strategies.push({ type: 'SEMANTIC' });
  }
  if (mem.mode === 'STM_AND_LTM') {
    strategies.push({ type: 'SUMMARIZATION' });
    strategies.push({ type: 'USER_PREFERENCE' });
  }

  return {
    type: 'AgentCoreMemory',
    name: mem.name,
    eventExpiryDuration: Math.max(7, Math.min(365, mem.eventExpiryDays)),
    strategies,
  };
}

export interface ScaffoldOptions {
  parsedConfig: ParsedStarterToolkitConfig;
  projectName: string;
  targetName: string;
  projectRoot: string;
}

/**
 * Scaffold or update an agentcore-cli project from parsed starter toolkit config.
 * Returns the project spec and target.
 */
export async function scaffoldProject(options: ScaffoldOptions): Promise<{
  projectSpec: AgentCoreProjectSpec;
  target: AwsDeploymentTarget;
  configIO: ConfigIO;
}> {
  const { parsedConfig, projectName, targetName, projectRoot } = options;
  const configBaseDir = path.join(projectRoot, CONFIG_DIR);

  const configIO = new ConfigIO({ baseDir: configBaseDir });

  // Determine if project already exists by checking for the actual config file
  const projectExists = existsSync(path.join(configBaseDir, CONFIG_FILES.AGENT_ENV));

  // Build target
  const target: AwsDeploymentTarget = {
    name: targetName,
    account: parsedConfig.awsTarget.account ?? '',
    region: parsedConfig.awsTarget.region ?? 'us-east-1',
  };

  if (!projectExists) {
    // Create new project structure
    await configIO.initializeBaseDir();

    // Create CDK project
    const cdkRenderer = new CDKRenderer();
    await cdkRenderer.render({ projectRoot });
  }

  // Build project spec
  let projectSpec: AgentCoreProjectSpec;

  if (projectExists) {
    // Merge into existing project
    projectSpec = await configIO.readProjectSpec();

    // Add new agents (skip duplicates)
    const existingAgentNames = new Set(projectSpec.agents.map(a => a.name));
    for (const agent of parsedConfig.agents) {
      if (!existingAgentNames.has(agent.name)) {
        projectSpec.agents.push(toAgentEnvSpec(agent, projectRoot));
      }
    }

    // Add new memories (skip duplicates)
    const existingMemoryNames = new Set((projectSpec.memories ?? []).map(m => m.name));
    for (const mem of parsedConfig.memories) {
      if (!existingMemoryNames.has(mem.name)) {
        (projectSpec.memories ??= []).push(toMemorySpec(mem));
      }
    }
  } else {
    projectSpec = {
      name: projectName,
      version: SCHEMA_VERSION,
      agents: parsedConfig.agents.map(a => toAgentEnvSpec(a, projectRoot)),
      memories: parsedConfig.memories.map(toMemorySpec),
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
    };
  }

  // Write config files
  await configIO.writeProjectSpec(projectSpec);

  // Write or update AWS targets
  if (projectExists) {
    const existingTargets = await configIO.readAWSDeploymentTargets();
    if (!existingTargets.find(t => t.name === targetName)) {
      existingTargets.push(target);
      await configIO.writeAWSDeploymentTargets(existingTargets);
    }
  } else {
    await configIO.writeAWSDeploymentTargets([target]);
  }

  // Write empty deployed state if not exists
  if (!projectExists) {
    await configIO.writeDeployedState({ targets: {} });
  }

  return { projectSpec, target, configIO };
}
