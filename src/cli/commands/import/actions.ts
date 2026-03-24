import { APP_DIR, ConfigIO, findConfigRoot } from '../../../lib';
import type { AgentCoreRegion, AgentEnvSpec, AwsDeploymentTarget, Credential, Memory } from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { silentIoHost } from '../../cdk/toolkit-lib';
import { buildCdkProject, synthesizeCdk } from '../../operations/deploy';
import { setupPythonProject } from '../../operations/python/setup';
import { executePhase1, getDeployedTemplate } from './phase1-update';
import { executePhase2, publishCdkAssets } from './phase2-import';
import type { CfnTemplate } from './template-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResult, ParsedStarterToolkitConfig, ResourceToImport } from './types';
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

/**
 * Convert parsed starter toolkit agents to CLI AgentEnvSpec format.
 */
function toAgentEnvSpec(agent: ParsedStarterToolkitConfig['agents'][0]): AgentEnvSpec {
  const codeLocation = path.join(APP_DIR, agent.name);
  const entrypoint = path.basename(agent.entrypoint);

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
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
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

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

/**
 * Convert parsed starter toolkit credential to CLI Credential format.
 * OAuth providers map to OAuthCredentialProvider (discoveryUrl omitted — provider already exists in Identity service).
 * API key providers map to ApiKeyCredentialProvider.
 */
function toCredentialSpec(cred: ParsedStarterToolkitConfig['credentials'][0]): Credential {
  if (cred.providerType === 'api_key') {
    return { type: 'ApiKeyCredentialProvider', name: cred.name };
  }
  // OAuth providers already exist in Identity service. We map them as OAuthCredentialProvider
  // so the CLI correctly wires CLIENT_ID/CLIENT_SECRET env vars (not API_KEY).
  // discoveryUrl is omitted since it's not available from the YAML and the provider
  // already exists — pre-deploy will skip if no credentials are in .env.local.
  return { type: 'OAuthCredentialProvider', name: cred.name, vendor: 'CustomOauth2' };
}

export async function handleImport(options: ImportOptions): Promise<ImportResult> {
  const { source, onProgress } = options;

  try {
    // 1. Validate we're inside an existing agentcore project
    const configRoot = findConfigRoot(process.cwd());
    if (!configRoot) {
      return {
        success: false,
        error:
          'No agentcore project found in the current directory.\nRun `agentcore create <name>` first, then run import from inside the project.',
      };
    }

    const projectRoot = path.dirname(configRoot);
    const configIO = new ConfigIO({ baseDir: configRoot });

    // 2. Read existing project config
    const projectSpec = await configIO.readProjectSpec();
    const projectName = projectSpec.name;
    onProgress?.(`Using existing project: ${projectName}`);

    // 3. Parse the YAML config (before target resolution so we can use YAML info if needed)
    onProgress?.(`Parsing ${source}...`);
    const parsed = parseStarterToolkitYaml(source);

    if (parsed.agents.length === 0) {
      return { success: false, error: 'No agents found in the YAML config' };
    }

    onProgress?.(
      `Found ${parsed.agents.length} agent(s), ${parsed.memories.length} memory(ies), ${parsed.credentials.length} credential(s)`
    );

    // Check early whether there are any physical IDs to import.
    // This determines whether we need strict target resolution (account/region required).
    const hasPhysicalIds = parsed.agents.some(a => a.physicalAgentId) || parsed.memories.some(m => m.physicalMemoryId);

    // 4. Resolve deployment target
    let target: AwsDeploymentTarget | undefined;

    if (hasPhysicalIds) {
      // Strict target resolution: we NEED a valid target for CloudFormation import.
      // If the YAML specifies a region, override AWS_REGION before reading targets
      // because readAWSDeploymentTargets() overrides file-based regions with AWS_REGION.
      // The YAML region is authoritative — it's where the resources actually exist.
      if (parsed.awsTarget.region) {
        process.env.AWS_REGION = parsed.awsTarget.region;
        process.env.AWS_DEFAULT_REGION = parsed.awsTarget.region;
      }
      let targets = await configIO.readAWSDeploymentTargets();

      // If no targets exist (CLI-mode create leaves targets empty), create one from YAML info
      if (targets.length === 0) {
        if (!parsed.awsTarget.account || !parsed.awsTarget.region) {
          return {
            success: false,
            error:
              'No deployment targets found in project and YAML has no AWS account/region info.\nRun `agentcore deploy` first to set up a target, then re-run import.',
          };
        }
        const defaultTarget: AwsDeploymentTarget = {
          name: 'default',
          account: parsed.awsTarget.account,
          region: parsed.awsTarget.region as AgentCoreRegion,
        };
        await configIO.writeAWSDeploymentTargets([defaultTarget]);
        targets = [defaultTarget];
        onProgress?.(`Created default target from YAML: ${defaultTarget.region}, ${defaultTarget.account}`);
      }

      if (options.target) {
        const found = targets.find(t => t.name === options.target);
        if (!found) {
          const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
          return {
            success: false,
            error: `Target "${options.target}" not found. Available targets:\n${names}`,
          };
        }
        target = found;
      } else if (targets.length === 1) {
        target = targets[0]!;
      } else {
        const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
        return {
          success: false,
          error: `Multiple deployment targets found. Specify one with --target:\n${names}`,
        };
      }

      onProgress?.(`Using target: ${target.name} (${target.region}, ${target.account})`);

      // Warn if YAML account/region differs from target
      if (parsed.awsTarget.account && parsed.awsTarget.account !== target.account) {
        onProgress?.(
          `Warning: YAML account (${parsed.awsTarget.account}) differs from target account (${target.account})`
        );
      }
      if (parsed.awsTarget.region && parsed.awsTarget.region !== target.region) {
        onProgress?.(`Warning: YAML region (${parsed.awsTarget.region}) differs from target region (${target.region})`);
      }

      // Validate AWS credentials
      onProgress?.('Validating AWS credentials...');
      await validateAwsCredentials();
    } else {
      // No physical IDs — target is only needed for stackName computation.
      // Try to read existing targets gracefully; don't fail if none exist.
      const targets = await configIO.readAWSDeploymentTargets().catch(() => [] as AwsDeploymentTarget[]);
      if (targets.length === 1) {
        target = targets[0];
      } else if (options.target) {
        target = targets.find(t => t.name === options.target);
      }
      // If still no target, that's fine — we'll use 'default' for the stackName
    }

    // 5. Merge agents/memories into existing project config
    onProgress?.('Merging into existing project...');
    const existingAgentNames = new Set(projectSpec.agents.map(a => a.name));
    const newlyAddedAgentNames = new Set<string>();
    for (const agent of parsed.agents) {
      if (!existingAgentNames.has(agent.name)) {
        projectSpec.agents.push(toAgentEnvSpec(agent));
        newlyAddedAgentNames.add(agent.name);
      } else {
        onProgress?.(`Skipping agent "${agent.name}" (already exists in project)`);
      }
    }

    for (const agent of parsed.agents) {
      if (agent.hasAuthorizerConfig) {
        onProgress?.(
          `Warning: Agent "${agent.name}" has a custom JWT authorizer configured in the starter toolkit. ` +
            `This is not automatically imported. To recreate it, run: agentcore add gateway --authorizer-type CUSTOM_JWT`
        );
      }
    }

    const existingMemoryNames = new Set((projectSpec.memories ?? []).map(m => m.name));
    const newlyAddedMemoryNames = new Set<string>();
    for (const mem of parsed.memories) {
      if (!existingMemoryNames.has(mem.name)) {
        (projectSpec.memories ??= []).push(toMemorySpec(mem));
        newlyAddedMemoryNames.add(mem.name);
      } else {
        onProgress?.(`Skipping memory "${mem.name}" (already exists in project)`);
      }
    }

    // Warn about memory env var mismatch for imported agents
    if (parsed.memories.length > 0) {
      for (const mem of parsed.memories) {
        const cdkEnvVar = `MEMORY_${mem.name.toUpperCase().replace(/[.-]/g, '_')}_ID`;
        onProgress?.(
          `Warning: Memory "${mem.name}" env var must be updated in your agent code:\n` +
            `  \x1b[31m- MEMORY_ID = os.getenv("BEDROCK_AGENTCORE_MEMORY_ID")\x1b[0m\n` +
            `  \x1b[32m+ MEMORY_ID = os.getenv("${cdkEnvVar}")\x1b[0m`
        );
      }
    }

    const existingCredentialNames = new Set((projectSpec.credentials ?? []).map(c => c.name));
    for (const cred of parsed.credentials) {
      if (!existingCredentialNames.has(cred.name)) {
        (projectSpec.credentials ??= []).push(toCredentialSpec(cred));
        onProgress?.(`Added credential "${cred.name}" (${cred.providerType})`);
      } else {
        onProgress?.(`Skipping credential "${cred.name}" (already exists in project)`);
      }
    }

    // Write updated project config
    await configIO.writeProjectSpec(projectSpec);

    // 6. Copy agent source code to app/<name>/ (only for newly added agents)
    for (const agent of parsed.agents) {
      if (existingAgentNames.has(agent.name)) {
        onProgress?.(`Skipping source copy for agent "${agent.name}" (already exists in project)`);
        continue;
      }
      const appDir = path.join(projectRoot, APP_DIR, agent.name);
      if (!fs.existsSync(appDir)) {
        fs.mkdirSync(appDir, { recursive: true });
      }

      if (agent.sourcePath && fs.existsSync(agent.sourcePath)) {
        onProgress?.(`Copying agent source from ${agent.sourcePath} to ./${APP_DIR}/${agent.name}`);
        copyDirRecursive(agent.sourcePath, appDir);

        // Also copy pyproject.toml from the parent of source_path if it exists
        const parentPyproject = path.join(path.dirname(agent.sourcePath), 'pyproject.toml');
        const destPyproject = path.join(appDir, 'pyproject.toml');
        if (fs.existsSync(parentPyproject) && !fs.existsSync(destPyproject)) {
          fs.copyFileSync(parentPyproject, destPyproject);
        }

        // For Container builds, copy the Dockerfile from the starter toolkit config dir
        if (agent.build === 'Container') {
          const destDockerfile = path.join(appDir, 'Dockerfile');
          if (!fs.existsSync(destDockerfile)) {
            // Starter toolkit stores Dockerfile at .bedrock_agentcore/<agentName>/Dockerfile
            const toolkitProjectDir = path.dirname(agent.sourcePath);
            const toolkitDockerfile = path.join(toolkitProjectDir, '.bedrock_agentcore', agent.name, 'Dockerfile');
            if (fs.existsSync(toolkitDockerfile)) {
              onProgress?.(`Copying Dockerfile from starter toolkit config`);
              fs.copyFileSync(toolkitDockerfile, destDockerfile);
            } else {
              // Generate a minimal Dockerfile for Container builds
              onProgress?.(`Generating Dockerfile for Container build`);
              const entryModule = path.basename(agent.entrypoint, '.py');
              fs.writeFileSync(
                destDockerfile,
                [
                  'FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim',
                  'WORKDIR /app',
                  '',
                  'ENV UV_SYSTEM_PYTHON=1 \\',
                  '    UV_COMPILE_BYTECODE=1 \\',
                  '    UV_NO_PROGRESS=1 \\',
                  '    PYTHONUNBUFFERED=1 \\',
                  '    DOCKER_CONTAINER=1',
                  '',
                  'RUN useradd -m -u 1000 bedrock_agentcore',
                  '',
                  'COPY pyproject.toml uv.lock ./',
                  'RUN uv sync --frozen --no-dev --no-install-project',
                  '',
                  'COPY --chown=bedrock_agentcore:bedrock_agentcore . .',
                  'RUN uv sync --frozen --no-dev',
                  '',
                  'USER bedrock_agentcore',
                  '',
                  'EXPOSE 8080 8000 9000',
                  '',
                  `CMD ["opentelemetry-instrument", "python", "-m", "${entryModule}"]`,
                  '',
                ].join('\n')
              );
            }
          }
        }
      } else {
        // Create a minimal pyproject.toml if no source path available
        const pyprojectPath = path.join(appDir, 'pyproject.toml');
        if (!fs.existsSync(pyprojectPath)) {
          onProgress?.(`Creating minimal pyproject.toml at ${appDir}`);
          fs.writeFileSync(
            pyprojectPath,
            [
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
            ].join('\n')
          );
        }
      }

      // Container agents install dependencies inside the Docker image,
      // so skip local Python environment setup for them.
      if (agent.build !== 'Container') {
        // Fix pyproject.toml for setuptools: starter toolkit projects may have
        // multiple top-level directories (model/, mcp_client/, etc.) which causes
        // setuptools auto-discovery to fail. Add py-modules = [] to suppress this.
        fixPyprojectForSetuptools(path.join(appDir, 'pyproject.toml'));

        // Set up Python environment (venv + install dependencies)
        onProgress?.(`Setting up Python environment for ${agent.name}...`);
        const setupResult = await setupPythonProject({ projectDir: appDir });
        if (setupResult.status === 'success') {
          onProgress?.(`Python environment ready for ${agent.name}`);
        } else if (setupResult.status === 'uv_not_found') {
          onProgress?.(`Warning: uv not found — run "uv sync" manually in ${APP_DIR}/${agent.name}`);
        } else {
          onProgress?.(`Warning: Python setup failed for ${agent.name}: ${setupResult.error ?? setupResult.status}`);
        }
      }
    }

    // 7. Determine which resources need importing (have physical IDs).
    // Only import newly added resources — skip ones already in the project.
    const agentsToImport = parsed.agents.filter(a => {
      return a.physicalAgentId && newlyAddedAgentNames.has(a.name);
    });
    const memoriesToImport = parsed.memories.filter(m => {
      return m.physicalMemoryId && newlyAddedMemoryNames.has(m.name);
    });
    const targetName = target?.name ?? 'default';
    const stackName = toStackName(projectName, targetName);

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

    onProgress?.(`Will import: ${agentsToImport.length} agent(s), ${memoriesToImport.length} memory(ies)`);

    // At this point we know hasPhysicalIds is true, so target must be defined.
    if (!target) {
      return { success: false, error: 'No deployment target available for import.' };
    }

    // 8. Build and synth CDK to get the full template
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
    } catch (_err) {
      // Try without stack name prefix
      const files = fs.readdirSync(assemblyDirectory).filter((f: string) => f.endsWith('.template.json'));
      if (files.length === 0) {
        await toolkitWrapper.dispose();
        return { success: false, error: 'No CloudFormation template found in CDK assembly' };
      }
      synthTemplate = JSON.parse(fs.readFileSync(path.join(assemblyDirectory, files[0]!), 'utf-8')) as CfnTemplate;
    }

    await toolkitWrapper.dispose();

    // 8b. Publish CDK assets to S3 (source zips needed by CodeBuild during Phase 1)
    onProgress?.('Publishing CDK assets to S3...');
    await publishCdkAssets(assemblyDirectory, target.region, onProgress);

    // 9. Phase 1: UPDATE — deploy companion resources
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

    // 10. Phase 2: IMPORT — adopt primary resources
    onProgress?.('Reading deployed template...');
    const deployedTemplate = await getDeployedTemplate(target.region, stackName);
    if (!deployedTemplate) {
      return { success: false, error: 'Could not read deployed template after Phase 1' };
    }

    // Build ResourcesToImport list
    const resourcesToImport: ResourceToImport[] = [];

    for (const agent of agentsToImport) {
      const runtimeLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Runtime');
      let logicalId: string | undefined;

      const expectedRuntimeName = `${projectName}_${agent.name}`;
      logicalId = findLogicalIdByProperty(
        synthTemplate,
        'AWS::BedrockAgentCore::Runtime',
        'AgentRuntimeName',
        expectedRuntimeName
      );

      if (!logicalId && runtimeLogicalIds.length === 1) {
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

      logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', memory.name);

      // CDK prefixes memory names with the project name (e.g. "myproject_Agent_mem"),
      // so also try matching with the project name prefix.
      if (!logicalId) {
        const prefixedName = `${projectName}_${memory.name}`;
        logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', prefixedName);
      }

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

    // 11. Update deployed state
    onProgress?.('Updating deployed state...');
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
    const existingState: any = await configIO.readDeployedState().catch(() => ({ targets: {} }));
    const targetState = existingState.targets[targetName] ?? { resources: {} };
    targetState.resources ??= {};
    targetState.resources.stackName = stackName;

    if (agentsToImport.length > 0) {
      targetState.resources.agents ??= {};
      for (const agent of agentsToImport) {
        if (agent.physicalAgentId) {
          targetState.resources.agents[agent.name] = {
            runtimeId: agent.physicalAgentId,
            runtimeArn:
              agent.physicalAgentArn ??
              `arn:aws:bedrock-agentcore:${target.region}:${target.account}:runtime/${agent.physicalAgentId}`,
            roleArn: 'imported', // Placeholder — updated after agentcore deploy
          };
        }
      }
    }

    if (memoriesToImport.length > 0) {
      targetState.resources.memories ??= {};
      for (const memory of memoriesToImport) {
        if (memory.physicalMemoryId) {
          targetState.resources.memories[memory.name] = {
            memoryId: memory.physicalMemoryId,
            memoryArn:
              memory.physicalMemoryArn ??
              `arn:aws:bedrock-agentcore:${target.region}:${target.account}:memory/${memory.physicalMemoryId}`,
          };
        }
      }
    }

    existingState.targets[targetName] = targetState;
    await configIO.writeDeployedState(existingState);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

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
 * Fix pyproject.toml for setuptools auto-discovery issues.
 * Starter toolkit projects may have multiple top-level directories (model/, mcp_client/)
 * which causes setuptools to refuse building. Adding `py-modules = []` tells setuptools
 * not to auto-discover packages.
 */
function fixPyprojectForSetuptools(pyprojectPath: string): void {
  if (!fs.existsSync(pyprojectPath)) return;

  const content = fs.readFileSync(pyprojectPath, 'utf-8');

  // Already has [tool.setuptools] section — don't touch it
  if (content.includes('[tool.setuptools]')) return;

  // Append the fix
  fs.writeFileSync(pyprojectPath, content.trimEnd() + '\n\n[tool.setuptools]\npy-modules = []\n');
}

const COPY_EXCLUDE_DIRS = new Set([
  '.venv',
  '.git',
  '__pycache__',
  'node_modules',
  '.pytest_cache',
  '.bedrock_agentcore',
  '.mypy_cache',
  '.ruff_cache',
]);

/**
 * Recursively copy directory contents, skipping excluded directories and symlinks.
 */
function copyDirRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (COPY_EXCLUDE_DIRS.has(entry.name)) continue;
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
