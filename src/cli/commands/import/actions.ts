import { APP_DIR, ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { silentIoHost } from '../../cdk/toolkit-lib';
import { buildCdkProject, synthesizeCdk } from '../../operations/deploy';
import { CFN_RESOURCE_IDENTIFIERS } from './constants';
import { executePhase1, getDeployedTemplate } from './phase1-update';
import { executePhase2 } from './phase2-import';
import { scaffoldProject } from './scaffold';
import type { CfnTemplate } from './template-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResult, ResourceToImport } from './types';
import { parseStarterToolkitYaml } from './yaml-parser';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ImportOptions {
  source: string;
  target?: string;
  yes?: boolean;
  onProgress?: (message: string) => void;
}

function sanitize(name: string): string {
  return name.replace(/_/g, '-');
}

function toStackName(projectName: string, targetName: string): string {
  return `AgentCore-${sanitize(projectName)}-${sanitize(targetName)}`;
}

export async function handleImport(options: ImportOptions): Promise<ImportResult> {
  const { source, target: targetName = 'default', onProgress } = options;

  try {
    // 1. Parse the YAML config
    onProgress?.(`Parsing ${source}...`);
    const parsed = parseStarterToolkitYaml(source);

    if (parsed.agents.length === 0) {
      return { success: false, error: 'No agents found in the YAML config' };
    }

    onProgress?.(`Found ${parsed.agents.length} agent(s) and ${parsed.memories.length} memory(ies)`);

    // Validate AWS credentials
    onProgress?.('Validating AWS credentials...');
    await validateAwsCredentials();

    // 2. Derive project name from the default agent or first agent name
    const projectName = sanitizeProjectName(parsed.defaultAgent ?? parsed.agents[0]!.name);

    // 3. Scaffold the project
    const projectRoot = process.cwd();
    onProgress?.('Scaffolding agentcore-cli project...');
    const { projectSpec, target, configIO } = await scaffoldProject({
      parsedConfig: parsed,
      projectName,
      targetName,
      projectRoot,
    });

    const stackName = toStackName(projectName, targetName);

    // Copy agent source code to app/<name>/ so CDK synth can find pyproject.toml
    for (const agent of parsed.agents) {
      const appDir = path.join(projectRoot, APP_DIR, agent.name);
      if (!fs.existsSync(appDir)) {
        fs.mkdirSync(appDir, { recursive: true });
      }

      if (agent.sourcePath && fs.existsSync(agent.sourcePath)) {
        onProgress?.(`Copying agent source from ${agent.sourcePath} to ${appDir}`);
        copyDirRecursive(agent.sourcePath, appDir);

        // Also copy pyproject.toml from the parent of source_path if it exists
        const parentPyproject = path.join(path.dirname(agent.sourcePath), 'pyproject.toml');
        const destPyproject = path.join(appDir, 'pyproject.toml');
        if (fs.existsSync(parentPyproject) && !fs.existsSync(destPyproject)) {
          fs.copyFileSync(parentPyproject, destPyproject);
        }
      } else {
        // Create a minimal pyproject.toml if no source path available
        const pyprojectPath = path.join(appDir, 'pyproject.toml');
        if (!fs.existsSync(pyprojectPath)) {
          onProgress?.(`Creating minimal pyproject.toml at ${appDir}`);
          fs.writeFileSync(pyprojectPath, [
            '[build-system]',
            'requires = ["setuptools>=68", "wheel"]',
            'build-backend = "setuptools.build_meta"',
            '',
            '[project]',
            `name = "${agent.name}"`,
            'version = "0.1.0"',
            'requires-python = ">=3.10"',
            'dependencies = []',
            '',
          ].join('\n'));
        }
      }
    }

    // 4. Determine which resources need importing (have physical IDs)
    const agentsToImport = parsed.agents.filter(a => a.physicalAgentId);
    const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);

    if (agentsToImport.length === 0 && memoriesToImport.length === 0) {
      onProgress?.(
        'No deployed resources found to import (no agent_id or memory_id in YAML). ' +
        'Run `agentcore deploy` to create new resources.'
      );
      return {
        success: true,
        projectSpec,
        importedAgents: [],
        importedMemories: [],
        stackName,
      };
    }

    onProgress?.(
      `Will import: ${agentsToImport.length} agent(s), ${memoriesToImport.length} memory(ies)`
    );

    // 5. Build and synth CDK to get the full template
    onProgress?.('Building CDK project...');
    const cdkProject = new LocalCdkProject(projectRoot);
    await buildCdkProject(cdkProject);

    onProgress?.('Synthesizing CloudFormation template...');
    const synthResult = await synthesizeCdk(cdkProject, { ioHost: silentIoHost });
    const { toolkitWrapper } = synthResult;

    // Read the synthesized template from the assembly directory
    const synthInfo = await toolkitWrapper.synth();
    const assemblyDirectory = synthInfo.assemblyDirectory;
    const synthTemplatePath = path.join(assemblyDirectory, `${stackName}.template.json`);

    let synthTemplate: CfnTemplate;
    try {
      synthTemplate = JSON.parse(fs.readFileSync(synthTemplatePath, 'utf-8')) as CfnTemplate;
    } catch (err) {
      // Try without stack name prefix
      const files = fs.readdirSync(assemblyDirectory).filter((f: string) => f.endsWith('.template.json'));
      if (files.length === 0) {
        await toolkitWrapper.dispose();
        return { success: false, error: 'No CloudFormation template found in CDK assembly' };
      }
      synthTemplate = JSON.parse(
        fs.readFileSync(path.join(assemblyDirectory, files[0]!), 'utf-8')
      ) as CfnTemplate;
    }

    await toolkitWrapper.dispose();

    // 6. Phase 1: UPDATE — deploy companion resources
    onProgress?.('Phase 1: Deploying companion resources (IAM roles, policies)...');
    const phase1Result = await executePhase1({
      region: target.region,
      stackName,
      synthTemplate,
      onProgress,
    });

    if (!phase1Result.success) {
      return { success: false, error: `Phase 1 failed: ${phase1Result.error}` };
    }

    // 7. Phase 2: IMPORT — adopt primary resources
    // Get the deployed template after Phase 1
    onProgress?.('Reading deployed template...');
    const deployedTemplate = await getDeployedTemplate(target.region, stackName);
    if (!deployedTemplate) {
      return { success: false, error: 'Could not read deployed template after Phase 1' };
    }

    // Build ResourcesToImport list
    const resourcesToImport: ResourceToImport[] = [];

    for (const agent of agentsToImport) {
      // Find the logical ID for this agent's runtime in the synthesized template
      const runtimeLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Runtime');
      let logicalId: string | undefined;

      // Match by name property - the runtime name is constructed as `${projectName}_${agentName}`
      const expectedRuntimeName = `${projectName}_${agent.name}`;
      logicalId = findLogicalIdByProperty(
        synthTemplate,
        'AWS::BedrockAgentCore::Runtime',
        'AgentRuntimeName',
        expectedRuntimeName
      );

      if (!logicalId && runtimeLogicalIds.length === 1) {
        // If only one runtime in template, use it
        logicalId = runtimeLogicalIds[0];
      }

      if (!logicalId) {
        onProgress?.(`Warning: Could not find logical ID for agent ${agent.name}, skipping`);
        continue;
      }

      resourcesToImport.push({
        resourceType: 'AWS::BedrockAgentCore::Runtime',
        logicalResourceId: logicalId,
        resourceIdentifier: { AgentRuntimeId: agent.physicalAgentId! },
      });
    }

    for (const memory of memoriesToImport) {
      const memoryLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory');
      let logicalId: string | undefined;

      logicalId = findLogicalIdByProperty(
        synthTemplate,
        'AWS::BedrockAgentCore::Memory',
        'Name',
        memory.name
      );

      if (!logicalId && memoryLogicalIds.length === 1) {
        logicalId = memoryLogicalIds[0];
      }

      if (!logicalId) {
        onProgress?.(`Warning: Could not find logical ID for memory ${memory.name}, skipping`);
        continue;
      }

      resourcesToImport.push({
        resourceType: 'AWS::BedrockAgentCore::Memory',
        logicalResourceId: logicalId,
        resourceIdentifier: { MemoryId: memory.physicalMemoryId! },
      });
    }

    if (resourcesToImport.length === 0) {
      onProgress?.('No resources could be matched for import');
      return {
        success: true,
        projectSpec,
        importedAgents: [],
        importedMemories: [],
        stackName,
      };
    }

    onProgress?.(`Phase 2: Importing ${resourcesToImport.length} resource(s) via CloudFormation IMPORT...`);
    const phase2Result = await executePhase2({
      region: target.region,
      stackName,
      deployedTemplate,
      synthTemplate,
      resourcesToImport,
      assemblyDirectory,
      onProgress,
    });

    if (!phase2Result.success) {
      return { success: false, error: `Phase 2 failed: ${phase2Result.error}` };
    }

    // 8. Update deployed state
    onProgress?.('Updating deployed state...');
    const existingState = await configIO.readDeployedState().catch(() => ({ targets: {} }));
    const targetState = existingState.targets[targetName] ?? { resources: {} };
    targetState.resources ??= {};
    targetState.resources.stackName = stackName;

    // Record imported agent IDs
    if (agentsToImport.length > 0) {
      targetState.resources.agents ??= {};
      for (const agent of agentsToImport) {
        if (agent.physicalAgentId) {
          targetState.resources.agents[agent.name] = {
            runtimeId: agent.physicalAgentId,
            runtimeArn: agent.physicalAgentArn ?? `arn:aws:bedrock-agentcore:${target.region}:${target.account}:runtime/${agent.physicalAgentId}`,
            roleArn: 'imported', // Placeholder — updated after agentcore deploy
          };
        }
      }
    }

    // Record imported memory IDs
    if (memoriesToImport.length > 0) {
      targetState.resources.memories ??= {};
      for (const memory of memoriesToImport) {
        if (memory.physicalMemoryId) {
          targetState.resources.memories[memory.name] = {
            memoryId: memory.physicalMemoryId,
            memoryArn: memory.physicalMemoryArn ?? '',
          };
        }
      }
    }

    existingState.targets[targetName] = targetState;
    await configIO.writeDeployedState(existingState as any);

    return {
      success: true,
      projectSpec,
      importedAgents: agentsToImport.map(a => a.name),
      importedMemories: memoriesToImport.map(m => m.name),
      stackName,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Recursively copy directory contents.
 */
function copyDirRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Sanitize a name to be a valid project name (alphanumeric, starts with letter, max 23 chars).
 */
function sanitizeProjectName(name: string): string {
  // Remove non-alphanumeric characters
  let sanitized = name.replace(/[^a-zA-Z0-9]/g, '');
  // Ensure starts with a letter
  if (sanitized.length === 0 || !/^[a-zA-Z]/.test(sanitized)) {
    sanitized = 'import' + sanitized;
  }
  // Truncate to 23 chars
  return sanitized.slice(0, 23);
}
