import { APP_DIR, ConfigIO, NoProjectError, ValidationError, findConfigRoot, toError } from '../../../lib';
import type {
  AgentCoreProjectSpec,
  AgentCoreRegion,
  AgentEnvSpec,
  AwsDeploymentTarget,
  Credential,
  Memory,
} from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { arnPrefix } from '../../aws/partition';
import { ExecLogger } from '../../logging';
import { setupPythonProject } from '../../operations/python/setup';
import { executeCdkImportPipeline } from './import-pipeline';
import { copyDirRecursive, fixPyprojectForSetuptools, toStackName } from './import-utils';
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

/**
 * Convert parsed starter toolkit agents to CLI AgentEnvSpec format.
 */
function toAgentEnvSpec(agent: ParsedStarterToolkitConfig['agents'][0]): AgentEnvSpec {
  const codeLocation = path.join(APP_DIR, agent.name);
  const entrypoint = path.basename(agent.entrypoint);

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
  const spec: AgentEnvSpec = {
    name: agent.name,
    build: agent.build,
    entrypoint: entrypoint as any,
    codeLocation: codeLocation as any,
    runtimeVersion: (agent.runtimeVersion ?? 'PYTHON_3_12') as any,
    protocol: agent.protocol,
    networkMode: agent.networkMode,
    instrumentation: { enableOtel: agent.protocol === 'MCP' ? false : agent.enableOtel },
  };
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

  if (agent.networkMode === 'VPC' && agent.networkConfig) {
    spec.networkConfig = agent.networkConfig;
  }

  if (agent.executionRoleArn) {
    spec.executionRoleArn = agent.executionRoleArn;
  }

  if (agent.authorizerType) {
    spec.authorizerType = agent.authorizerType;
  }
  if (agent.authorizerConfiguration) {
    spec.authorizerConfiguration = agent.authorizerConfiguration;
  }

  return spec;
}

/**
 * Convert parsed starter toolkit memory to CLI Memory format.
 */
function toMemorySpec(mem: ParsedStarterToolkitConfig['memories'][0]): Memory {
  const strategies: Memory['strategies'] = [];

  if (mem.mode === 'STM_AND_LTM') {
    strategies.push({ type: 'SEMANTIC' });
    strategies.push({ type: 'SUMMARIZATION' });
    strategies.push({ type: 'USER_PREFERENCE' });
  }

  return {
    name: mem.name,
    eventExpiryDuration: Math.max(3, Math.min(365, mem.eventExpiryDays)),
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
    return { authorizerType: 'ApiKeyCredentialProvider', name: cred.name };
  }
  // OAuth providers already exist in Identity service. We map them as OAuthCredentialProvider
  // so the CLI correctly wires CLIENT_ID/CLIENT_SECRET env vars (not API_KEY).
  // discoveryUrl is omitted since it's not available from the YAML and the provider
  // already exists — pre-deploy will skip if no credentials are in .env.local.
  return { authorizerType: 'OAuthCredentialProvider', name: cred.name, vendor: 'CustomOauth2' };
}

export async function handleImport(options: ImportOptions): Promise<ImportResult> {
  const { source, onProgress } = options;
  const logger = new ExecLogger({ command: 'import' });

  // Rollback state — hoisted so the catch block can access it
  let configIO: ConfigIO | undefined;
  let configSnapshot: AgentCoreProjectSpec;
  let configWritten = false;

  const rollbackConfig = async () => {
    if (!configWritten || !configIO) return;
    try {
      await configIO.writeProjectSpec(configSnapshot);
      onProgress?.('Rolling back config changes due to failure...');
      logger.log('Rolled back config to pre-import state');
    } catch (rollbackErr) {
      logger.log(`Warning: config rollback failed: ${String(rollbackErr)}`, 'error');
    }
  };

  try {
    // 1. Validate we're inside an existing agentcore project
    logger.startStep('Validate project context');
    const configRoot = findConfigRoot(process.cwd());
    if (!configRoot) {
      const error = new NoProjectError(
        'No agentcore project found in the current directory.\nRun `agentcore create <name>` first, then run import from inside the project.'
      );
      logger.endStep('error', error.message);
      logger.finalize(false);
      return {
        success: false,
        error,
        logPath: logger.getRelativeLogPath(),
      };
    }

    const projectRoot = path.dirname(configRoot);
    configIO = new ConfigIO({ baseDir: configRoot });
    logger.endStep('success');

    // 2. Read existing project config
    logger.startStep('Read project config');
    const projectSpec = await configIO.readProjectSpec();
    const projectName = projectSpec.name;
    logger.log(`Using existing project: ${projectName}`);
    onProgress?.(`Using existing project: ${projectName}`);
    logger.endStep('success');

    // Snapshot for rollback if CDK/CFN phases fail after config is written
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;

    // 3. Parse the YAML config (before target resolution so we can use YAML info if needed)
    logger.startStep('Parse YAML');
    logger.log(`Parsing ${source}...`);
    onProgress?.(`Parsing ${source}...`);
    const parsed = parseStarterToolkitYaml(source);

    if (parsed.agents.length === 0) {
      const error = 'No agents found in the YAML config';
      logger.endStep('error', error);
      logger.finalize(false);
      return { success: false, error: new ValidationError(error), logPath: logger.getRelativeLogPath() };
    }

    logger.log(
      `Found ${parsed.agents.length} agent(s), ${parsed.memories.length} memory(ies), ${parsed.credentials.length} credential(s)`
    );
    onProgress?.(
      `Found ${parsed.agents.length} agent(s), ${parsed.memories.length} memory(ies), ${parsed.credentials.length} credential(s)`
    );
    logger.endStep('success');

    // Check early whether there are any physical IDs to import.
    // This determines whether we need strict target resolution (account/region required).
    const hasPhysicalIds = parsed.agents.some(a => a.physicalAgentId) || parsed.memories.some(m => m.physicalMemoryId);

    // 4. Resolve deployment target
    logger.startStep('Resolve deployment target');
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
          const error =
            'No deployment targets found in project and YAML has no AWS account/region info.\nRun `agentcore deploy` first to set up a target, then re-run import.';
          logger.endStep('error', error);
          logger.finalize(false);
          return {
            success: false,
            error: new Error(error),
            logPath: logger.getRelativeLogPath(),
          };
        }
        const defaultTarget: AwsDeploymentTarget = {
          name: 'default',
          account: parsed.awsTarget.account,
          region: parsed.awsTarget.region as AgentCoreRegion,
        };
        await configIO.writeAWSDeploymentTargets([defaultTarget]);
        targets = [defaultTarget];
        logger.log(`Created default target from YAML: ${defaultTarget.region}, ${defaultTarget.account}`);
        onProgress?.(`Created default target from YAML: ${defaultTarget.region}, ${defaultTarget.account}`);
      }

      if (options.target) {
        const found = targets.find(t => t.name === options.target);
        if (!found) {
          const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
          const error = `Target "${options.target}" not found. Available targets:\n${names}`;
          logger.endStep('error', error);
          logger.finalize(false);
          return {
            success: false,
            error: new Error(error),
            logPath: logger.getRelativeLogPath(),
          };
        }
        target = found;
      } else if (targets.length === 1) {
        target = targets[0]!;
      } else {
        const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
        const error = `Multiple deployment targets found. Specify one with --target:\n${names}`;
        logger.endStep('error', error);
        logger.finalize(false);
        return {
          success: false,
          error: new Error(error),
          logPath: logger.getRelativeLogPath(),
        };
      }

      logger.log(`Using target: ${target.name} (${target.region}, ${target.account})`);
      onProgress?.(`Using target: ${target.name} (${target.region}, ${target.account})`);

      // Warn if YAML account/region differs from target
      if (parsed.awsTarget.account && parsed.awsTarget.account !== target.account) {
        logger.log(
          `Warning: YAML account (${parsed.awsTarget.account}) differs from target account (${target.account})`,
          'warn'
        );
        onProgress?.(
          `Warning: YAML account (${parsed.awsTarget.account}) differs from target account (${target.account})`
        );
      }
      if (parsed.awsTarget.region && parsed.awsTarget.region !== target.region) {
        logger.log(
          `Warning: YAML region (${parsed.awsTarget.region}) differs from target region (${target.region})`,
          'warn'
        );
        onProgress?.(`Warning: YAML region (${parsed.awsTarget.region}) differs from target region (${target.region})`);
      }

      // Validate AWS credentials
      logger.log('Validating AWS credentials...');
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
    logger.endStep('success');

    // 5. Merge agents/memories into existing project config
    logger.startStep('Merge agents and memories');
    logger.log('Merging into existing project...');
    onProgress?.('Merging into existing project...');
    const existingAgentNames = new Set(projectSpec.runtimes.map(a => a.name));
    const newlyAddedAgentNames = new Set<string>();
    for (const agent of parsed.agents) {
      if (!existingAgentNames.has(agent.name)) {
        projectSpec.runtimes.push(toAgentEnvSpec(agent));
        newlyAddedAgentNames.add(agent.name);
      } else {
        logger.log(`Skipping agent "${agent.name}" (already exists in project)`);
        onProgress?.(`Skipping agent "${agent.name}" (already exists in project)`);
      }
    }

    const existingMemoryNames = new Set((projectSpec.memories ?? []).map(m => m.name));
    const newlyAddedMemoryNames = new Set<string>();
    for (const mem of parsed.memories) {
      if (!existingMemoryNames.has(mem.name)) {
        (projectSpec.memories ??= []).push(toMemorySpec(mem));
        newlyAddedMemoryNames.add(mem.name);
      } else {
        logger.log(`Skipping memory "${mem.name}" (already exists in project)`);
        onProgress?.(`Skipping memory "${mem.name}" (already exists in project)`);
      }
    }

    // Warn about memory env var mismatch for imported agents
    if (parsed.memories.length > 0) {
      for (const mem of parsed.memories) {
        const cdkEnvVar = `MEMORY_${mem.name.toUpperCase().replace(/[.-]/g, '_')}_ID`;
        const warnMsg =
          `Warning: Memory "${mem.name}" env var must be updated in your agent code:\n` +
          `  \x1b[31m- MEMORY_ID = os.getenv("BEDROCK_AGENTCORE_MEMORY_ID")\x1b[0m\n` +
          `  \x1b[32m+ MEMORY_ID = os.getenv("${cdkEnvVar}")\x1b[0m`;
        logger.log(`Memory "${mem.name}" env var must be updated: use ${cdkEnvVar}`, 'warn');
        onProgress?.(warnMsg);
      }
    }

    const existingCredentialNames = new Set((projectSpec.credentials ?? []).map(c => c.name));
    for (const cred of parsed.credentials) {
      if (!existingCredentialNames.has(cred.name)) {
        (projectSpec.credentials ??= []).push(toCredentialSpec(cred));
        logger.log(`Added credential "${cred.name}" (${cred.providerType})`);
        onProgress?.(`Added credential "${cred.name}" (${cred.providerType})`);
      } else {
        logger.log(`Skipping credential "${cred.name}" (already exists in project)`);
        onProgress?.(`Skipping credential "${cred.name}" (already exists in project)`);
      }
    }

    // Write updated project config
    await configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    logger.endStep('success');

    // 6. Copy agent source code to app/<name>/ (only for newly added agents)
    logger.startStep('Copy agent source and setup Python');
    for (const agent of parsed.agents) {
      if (existingAgentNames.has(agent.name)) {
        logger.log(`Skipping source copy for agent "${agent.name}" (already exists in project)`);
        onProgress?.(`Skipping source copy for agent "${agent.name}" (already exists in project)`);
        continue;
      }
      const appDir = path.join(projectRoot, APP_DIR, agent.name);
      if (!fs.existsSync(appDir)) {
        fs.mkdirSync(appDir, { recursive: true });
      }

      if (agent.sourcePath && fs.existsSync(agent.sourcePath)) {
        logger.log(`Copying agent source from ${agent.sourcePath} to ./${APP_DIR}/${agent.name}`);
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
              logger.log('Copying Dockerfile from starter toolkit config');
              onProgress?.(`Copying Dockerfile from starter toolkit config`);
              fs.copyFileSync(toolkitDockerfile, destDockerfile);
            } else {
              // Generate a minimal Dockerfile for Container builds
              logger.log('Generating Dockerfile for Container build');
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
          logger.log(`Creating minimal pyproject.toml at ${appDir}`);
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
        logger.log(`Setting up Python environment for ${agent.name}...`);
        onProgress?.(`Setting up Python environment for ${agent.name}...`);
        const setupResult = await setupPythonProject({ projectDir: appDir });
        if (setupResult.status === 'success') {
          logger.log(`Python environment ready for ${agent.name}`);
          onProgress?.(`Python environment ready for ${agent.name}`);
        } else if (setupResult.status === 'uv_not_found') {
          logger.log(`Warning: uv not found — run "uv sync" manually in ${APP_DIR}/${agent.name}`, 'warn');
          onProgress?.(`Warning: uv not found — run "uv sync" manually in ${APP_DIR}/${agent.name}`);
        } else {
          logger.log(
            `Warning: Python setup failed for ${agent.name}: ${setupResult.error ?? setupResult.status}`,
            'warn'
          );
          onProgress?.(`Warning: Python setup failed for ${agent.name}: ${setupResult.error ?? setupResult.status}`);
        }
      }
    }
    logger.endStep('success');

    // 7. Determine which resources need importing (have physical IDs).
    // Only import newly added resources — skip ones already in the project.
    logger.startStep('Determine resources to import');
    const agentsToImport = parsed.agents.filter(a => {
      return a.physicalAgentId && newlyAddedAgentNames.has(a.name);
    });
    const memoriesToImport = parsed.memories.filter(m => {
      return m.physicalMemoryId && newlyAddedMemoryNames.has(m.name);
    });
    const targetName = target?.name ?? 'default';
    const stackName = toStackName(projectName, targetName);

    if (agentsToImport.length === 0 && memoriesToImport.length === 0) {
      const msg =
        'No deployed resources found to import (no agent_id or memory_id in YAML). ' +
        'Run `agentcore deploy` to create new resources.';
      logger.log(msg);
      onProgress?.(msg);
      logger.endStep('success');
      logger.finalize(true);
      return {
        success: true,
        projectSpec,
        importedAgents: [],
        importedMemories: [],
        stackName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    logger.log(`Will import: ${agentsToImport.length} agent(s), ${memoriesToImport.length} memory(ies)`);
    onProgress?.(`Will import: ${agentsToImport.length} agent(s), ${memoriesToImport.length} memory(ies)`);

    // At this point we know hasPhysicalIds is true, so target must be defined.
    if (!target) {
      const error = 'No deployment target available for import.';
      logger.endStep('error', error);
      logger.finalize(false);
      return { success: false, error: new ValidationError(error), logPath: logger.getRelativeLogPath() };
    }
    logger.endStep('success');

    // 8-11. CDK build → synth → bootstrap → phase 1 → phase 2 → update state
    logger.startStep('Build and import via CDK');
    const progressFn =
      onProgress ??
      ((_msg: string) => {
        /* no-op when caller doesn't provide onProgress */
      });

    const importedResources = [
      ...agentsToImport
        .filter(a => a.physicalAgentId)
        .map(a => ({
          type: 'runtime' as const,
          name: a.name,
          id: a.physicalAgentId!,
          arn:
            a.physicalAgentArn ??
            `${arnPrefix(target.region)}:bedrock-agentcore:${target.region}:${target.account}:runtime/${a.physicalAgentId}`,
        })),
      ...memoriesToImport
        .filter(m => m.physicalMemoryId)
        .map(m => ({
          type: 'memory' as const,
          name: m.name,
          id: m.physicalMemoryId!,
          arn:
            m.physicalMemoryArn ??
            `${arnPrefix(target.region)}:bedrock-agentcore:${target.region}:${target.account}:memory/${m.physicalMemoryId}`,
        })),
    ];

    const pipelineResult = await executeCdkImportPipeline({
      projectRoot,
      stackName,
      target,
      configIO,
      targetName,
      onProgress: progressFn,
      buildResourcesToImport: (synthTemplate, deployedTemplate) => {
        const resourcesToImport: ResourceToImport[] = [];
        const deployedIds = new Set(Object.keys(deployedTemplate.Resources));

        for (const agent of agentsToImport) {
          const runtimeLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Runtime').filter(
            id => !deployedIds.has(id)
          );
          let logicalId: string | undefined;

          const expectedRuntimeName = `${projectName}_${agent.name}`;
          logicalId = findLogicalIdByProperty(
            synthTemplate,
            'AWS::BedrockAgentCore::Runtime',
            'AgentRuntimeName',
            expectedRuntimeName,
            { excludeLogicalIds: deployedIds }
          );

          if (!logicalId && runtimeLogicalIds.length === 1) {
            logicalId = runtimeLogicalIds[0];
          }

          if (!logicalId) {
            logger.log(`Warning: Could not find logical ID for agent ${agent.name}, skipping`, 'warn');
            progressFn(`Warning: Could not find logical ID for agent ${agent.name}, skipping`);
            continue;
          }

          resourcesToImport.push({
            resourceType: 'AWS::BedrockAgentCore::Runtime',
            logicalResourceId: logicalId,
            resourceIdentifier: { AgentRuntimeId: agent.physicalAgentId! },
          });
        }

        for (const memory of memoriesToImport) {
          const memoryLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory').filter(
            id => !deployedIds.has(id)
          );
          let logicalId: string | undefined;

          logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', memory.name, {
            excludeLogicalIds: deployedIds,
          });

          // CDK prefixes memory names with the project name (e.g. "myproject_Agent_mem"),
          // so also try matching with the project name prefix.
          if (!logicalId) {
            const prefixedName = `${projectName}_${memory.name}`;
            logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', prefixedName, {
              excludeLogicalIds: deployedIds,
            });
          }

          if (!logicalId && memoryLogicalIds.length === 1) {
            logicalId = memoryLogicalIds[0];
          }

          if (!logicalId) {
            logger.log(`Warning: Could not find logical ID for memory ${memory.name}, skipping`, 'warn');
            progressFn(`Warning: Could not find logical ID for memory ${memory.name}, skipping`);
            continue;
          }

          resourcesToImport.push({
            resourceType: 'AWS::BedrockAgentCore::Memory',
            logicalResourceId: logicalId,
            resourceIdentifier: { MemoryId: memory.physicalMemoryId! },
          });
        }

        return resourcesToImport;
      },
      deployedStateEntries: importedResources,
    });

    if (pipelineResult.noResources) {
      logger.log('No resources could be matched for import');
      progressFn('No resources could be matched for import');
      logger.endStep('success');
      logger.finalize(true);
      return {
        success: true,
        projectSpec,
        importedAgents: [],
        importedMemories: [],
        stackName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    if (!pipelineResult.success) {
      const error = pipelineResult.error!;
      await rollbackConfig();
      logger.endStep('error', error);
      logger.finalize(false);
      return { success: false, error: new Error(error), logPath: logger.getRelativeLogPath() };
    }
    logger.endStep('success');

    logger.finalize(true);
    return {
      success: true,
      projectSpec,
      importedAgents: agentsToImport.map(a => a.name),
      importedMemories: memoriesToImport.map(m => m.name),
      stackName,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await rollbackConfig();
    logger.log(message, 'error');
    logger.finalize(false);
    return { success: false, error: toError(err), logPath: logger.getRelativeLogPath() };
  }
}
