import { APP_DIR, ConfigIO, findConfigRoot } from '../../../lib';
import type { AwsDeploymentTarget } from '../../../schema';
import { detectAccount, validateAwsCredentials } from '../../aws/account';
import { ExecLogger } from '../../logging';
import { setupPythonProject } from '../../operations/python/setup';
import { getTemplatePath } from '../../templates/templateRoot';
import { ANSI } from './constants';
import type { ImportResourceOptions, ImportResourceResult, ImportableResourceType } from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Import Context (shared setup for import-runtime / import-memory)
// ============================================================================

const { green, reset } = ANSI;

export interface ImportContext {
  ctx: ProjectContext;
  target: AwsDeploymentTarget;
  logger: ExecLogger;
  onProgress: (message: string) => void;
}

/**
 * Shared setup for single-resource import commands (runtime, memory).
 * Validates project context, resolves deployment target, and creates logger.
 */
export async function resolveImportContext(options: ImportResourceOptions, command: string): Promise<ImportContext> {
  const logger = new ExecLogger({ command });
  const onProgress =
    options.onProgress ??
    ((message: string) => {
      console.log(`${green}[done]${reset}  ${message}`);
    });

  logger.startStep('Validate project context');
  const ctx = await resolveProjectContext();
  logger.endStep('success');

  logger.startStep('Resolve deployment target');
  const target = await resolveImportTarget({
    configIO: ctx.configIO,
    targetName: options.target,
    arn: options.arn,
    onProgress,
  });
  logger.endStep('success');

  return { ctx, target, logger, onProgress };
}

// ============================================================================
// Error Result Helper
// ============================================================================

/**
 * Build a failed ImportResourceResult, logging the error and finalizing the logger.
 */
export function failResult(
  logger: ExecLogger,
  error: string,
  resourceType: ImportableResourceType,
  resourceName: string
): ImportResourceResult {
  logger.endStep('error', error);
  logger.finalize(false);
  return {
    success: false,
    error,
    resourceType,
    resourceName,
    logPath: logger.getRelativeLogPath(),
  };
}

// ============================================================================
// Project Context
// ============================================================================

export interface ProjectContext {
  projectRoot: string;
  configRoot: string;
  configIO: ConfigIO;
  projectName: string;
}

/**
 * Validate we're inside an agentcore project and return project context.
 */
export async function resolveProjectContext(): Promise<ProjectContext> {
  const configRoot = findConfigRoot(process.cwd());
  if (!configRoot) {
    throw new Error(
      'No agentcore project found in the current directory.\nRun `agentcore create <name>` first, then run import from inside the project.'
    );
  }

  const projectRoot = path.dirname(configRoot);
  const configIO = new ConfigIO({ baseDir: configRoot });
  const projectSpec = await configIO.readProjectSpec();

  return {
    projectRoot,
    configRoot,
    configIO,
    projectName: projectSpec.name,
  };
}

// ============================================================================
// Target Resolution
// ============================================================================

export interface ResolveTargetOptions {
  configIO: ConfigIO;
  targetName?: string;
  arn?: string;
  logger?: ExecLogger;
  onProgress?: (message: string) => void;
}

/**
 * Resolve the deployment target (account + region) for import.
 * Validates AWS credentials.
 */
export async function resolveImportTarget(options: ResolveTargetOptions): Promise<AwsDeploymentTarget> {
  const { configIO, targetName, arn, onProgress } = options;

  // Validate ARN format early if provided
  if (
    arn &&
    !/^arn:aws:bedrock-agentcore:([^:]+):([^:]+):(runtime|memory|evaluator|online-evaluation-config)\/(.+)$/.test(arn)
  ) {
    throw new Error(
      `Not a valid ARN: "${arn}".\nExpected format: arn:aws:bedrock-agentcore:<region>:<account>:<runtime|memory|evaluator|online-evaluation-config>/<id>`
    );
  }

  let targets = await configIO.readAWSDeploymentTargets();

  if (targets.length === 0) {
    if (!arn) {
      throw new Error(
        'No deployment targets found in project.\nRun `agentcore deploy` first to set up a target, or use --arn so a target can be created automatically.'
      );
    }

    const arnMatch = /^arn:aws:bedrock-agentcore:([^:]+):([^:]+):/.exec(arn);
    if (!arnMatch) {
      throw new Error(
        'No deployment targets found in project and could not parse region/account from ARN.\nRun `agentcore deploy` first to set up a target, then re-run import.'
      );
    }

    const [, arnRegion, arnAccount] = arnMatch;
    const newTarget: AwsDeploymentTarget = {
      name: 'default',
      description: `Default target (${arnRegion})`,
      account: arnAccount!,
      region: arnRegion! as AwsDeploymentTarget['region'],
    };

    onProgress?.(`No deployment targets found. Creating default target from ARN (${arnRegion}, ${arnAccount})...`);
    await configIO.writeAWSDeploymentTargets([newTarget]);
    targets = [newTarget];
  }

  let target: AwsDeploymentTarget | undefined;

  if (targetName) {
    target = targets.find(t => t.name === targetName);
    if (!target) {
      const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
      throw new Error(`Target "${targetName}" not found. Available targets:\n${names}`);
    }
  } else if (targets.length === 1) {
    target = targets[0]!;
  } else {
    const names = targets.map(t => `  - ${t.name} (${t.region}, ${t.account})`).join('\n');
    throw new Error(`Multiple deployment targets found. Specify one with --target:\n${names}`);
  }

  onProgress?.(`Using target: ${target.name} (${target.region}, ${target.account})`);

  // Validate AWS credentials
  onProgress?.('Validating AWS credentials...');
  await validateAwsCredentials();

  // Validate credentials match the target account
  const callerAccount = await detectAccount();
  if (callerAccount && target.account && callerAccount !== target.account) {
    throw new Error(
      `Your AWS credentials are for account ${callerAccount}, but the target "${target.name}" is configured for account ${target.account}.\nEnsure your credentials match the deployment target.`
    );
  }

  return target;
}

// ============================================================================
// ARN Validation
// ============================================================================

export interface ParsedArn {
  region: string;
  account: string;
  resourceType: string;
  resourceId: string;
}

const ARN_PATTERN =
  /^arn:aws:bedrock-agentcore:([^:]+):([^:]+):(runtime|memory|evaluator|online-evaluation-config)\/(.+)$/;

/** Unified config for each importable resource type — ARN mapping, deployed state keys. */
const RESOURCE_TYPE_CONFIG: Record<
  ImportableResourceType,
  {
    arnType: string;
    collectionKey: string;
    idField: string;
  }
> = {
  runtime: { arnType: 'runtime', collectionKey: 'runtimes', idField: 'runtimeId' },
  memory: { arnType: 'memory', collectionKey: 'memories', idField: 'memoryId' },
  evaluator: { arnType: 'evaluator', collectionKey: 'evaluators', idField: 'evaluatorId' },
  'online-eval': {
    arnType: 'online-evaluation-config',
    collectionKey: 'onlineEvalConfigs',
    idField: 'onlineEvaluationConfigId',
  },
};

/**
 * Parse and validate a BedrockAgentCore ARN.
 * Validates format, region, and account against the deployment target.
 */
export function parseAndValidateArn(
  arn: string,
  expectedResourceType: ImportableResourceType,
  target: { region: string; account: string }
): ParsedArn {
  const match = ARN_PATTERN.exec(arn);
  const expectedArnType = RESOURCE_TYPE_CONFIG[expectedResourceType].arnType;
  if (!match) {
    throw new Error(
      `Invalid ARN format: "${arn}". Expected format: arn:aws:bedrock-agentcore:<region>:<account>:${expectedArnType}/<id>`
    );
  }

  const [, region, account, resourceType, resourceId] = match;

  if (resourceType !== expectedArnType) {
    throw new Error(`ARN resource type "${resourceType}" does not match expected type "${expectedArnType}".`);
  }

  if (region !== target.region) {
    throw new Error(
      `ARN region "${region}" does not match target region "${target.region}". Use --target to select a different deployment target.`
    );
  }

  if (account !== target.account) {
    throw new Error(
      `ARN account "${account}" does not match target account "${target.account}". Ensure the ARN belongs to the correct account.`
    );
  }

  return { region, account, resourceType, resourceId: resourceId! };
}

// ============================================================================
// Stack Name
// ============================================================================

function replaceUnderscoresWithDashes(name: string): string {
  return name.replace(/_/g, '-');
}

export function toStackName(projectName: string, targetName: string): string {
  return `AgentCore-${replaceUnderscoresWithDashes(projectName)}-${replaceUnderscoresWithDashes(targetName)}`;
}

// ============================================================================
// Deployed State Update
// ============================================================================

/**
 * Check if a resource ID is already tracked in deployed-state.json for the given target.
 * Returns the name it's tracked under, or undefined if not found.
 */
export async function findResourceInDeployedState(
  configIO: ConfigIO,
  targetName: string,
  resourceType: ImportableResourceType,
  resourceId: string
): Promise<string | undefined> {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
  const state: any = await configIO.readDeployedState().catch(() => ({ targets: {} }));
  const targetState = state.targets?.[targetName];
  if (!targetState?.resources) return undefined;

  const { collectionKey, idField } = RESOURCE_TYPE_CONFIG[resourceType];

  const collection = targetState.resources[collectionKey];
  if (!collection) return undefined;
  for (const [name, entry] of Object.entries(collection)) {
    if ((entry as any)[idField] === resourceId) return name;
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

  return undefined;
}

export interface ImportedResource {
  type: ImportableResourceType;
  name: string;
  id: string;
  arn: string;
}

/**
 * Update deployed-state.json with imported resource IDs.
 */
export async function updateDeployedState(
  configIO: ConfigIO,
  targetName: string,
  stackName: string,
  resources: ImportedResource[]
): Promise<void> {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
  const existingState: any = await configIO.readDeployedState().catch(() => ({ targets: {} }));
  const targetState = existingState.targets[targetName] ?? { resources: {} };
  targetState.resources ??= {};
  targetState.resources.stackName = stackName;

  for (const resource of resources) {
    if (resource.type === 'runtime') {
      targetState.resources.runtimes ??= {};
      targetState.resources.runtimes[resource.name] = {
        runtimeId: resource.id,
        runtimeArn: resource.arn,
        roleArn: 'imported',
      };
    } else if (resource.type === 'memory') {
      targetState.resources.memories ??= {};
      targetState.resources.memories[resource.name] = {
        memoryId: resource.id,
        memoryArn: resource.arn,
      };
    } else if (resource.type === 'evaluator') {
      targetState.resources.evaluators ??= {};
      targetState.resources.evaluators[resource.name] = {
        evaluatorId: resource.id,
        evaluatorArn: resource.arn,
      };
    } else if (resource.type === 'online-eval') {
      targetState.resources.onlineEvalConfigs ??= {};
      targetState.resources.onlineEvalConfigs[resource.name] = {
        onlineEvaluationConfigId: resource.id,
        onlineEvaluationConfigArn: resource.arn,
      };
    }
  }

  existingState.targets[targetName] = targetState;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await configIO.writeDeployedState(existingState);
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
}

// ============================================================================
// Source Code Copy
// ============================================================================

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
export function copyDirRecursive(src: string, dest: string): void {
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

/**
 * Fix pyproject.toml for setuptools auto-discovery issues.
 */
export function fixPyprojectForSetuptools(pyprojectPath: string): void {
  if (!fs.existsSync(pyprojectPath)) return;

  const content = fs.readFileSync(pyprojectPath, 'utf-8');

  if (content.includes('[tool.setuptools]')) return;

  // Append the fix
  fs.writeFileSync(pyprojectPath, content.trimEnd() + '\n\n[tool.setuptools]\npy-modules = []\n');
}

export interface CopyAgentSourceOptions {
  sourcePath: string;
  agentName: string;
  projectRoot: string;
  build: 'CodeZip' | 'Container';
  entrypoint?: string;
  onProgress?: (message: string) => void;
}

/**
 * Copy agent source code into the project's app/<name>/ directory.
 * Handles pyproject.toml, Dockerfile, Python env setup.
 */
export async function copyAgentSource(options: CopyAgentSourceOptions): Promise<void> {
  const { sourcePath, agentName, projectRoot, build, onProgress } = options;

  const appDir = path.join(projectRoot, APP_DIR, agentName);
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  if (fs.existsSync(sourcePath)) {
    onProgress?.(`Copying agent source from ${sourcePath} to ./${APP_DIR}/${agentName}`);
    copyDirRecursive(sourcePath, appDir);

    const parentPyproject = path.join(path.dirname(sourcePath), 'pyproject.toml');
    const destPyproject = path.join(appDir, 'pyproject.toml');
    if (fs.existsSync(parentPyproject) && !fs.existsSync(destPyproject)) {
      fs.copyFileSync(parentPyproject, destPyproject);
    }

    // For Container builds, generate a Dockerfile if missing
    if (build === 'Container') {
      const destDockerfile = path.join(appDir, 'Dockerfile');
      if (!fs.existsSync(destDockerfile)) {
        const isPython = options.entrypoint?.endsWith('.py') ?? true;
        if (isPython) {
          onProgress?.('Generating Dockerfile for Container build');
          const entryModule = path.basename(options.entrypoint ?? 'main.py', '.py');
          const templatePath = getTemplatePath('container', 'python', 'Dockerfile');
          const template = fs.readFileSync(templatePath, 'utf-8');
          fs.writeFileSync(destDockerfile, template.replace('{{entrypoint}}', entryModule));
        } else {
          onProgress?.(
            'No Dockerfile found. Please add a Dockerfile to the source directory for non-Python container builds.'
          );
        }
      }
    }
  } else {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  // Container agents install dependencies inside the Docker image
  if (build !== 'Container') {
    fixPyprojectForSetuptools(path.join(appDir, 'pyproject.toml'));

    onProgress?.(`Setting up Python environment for ${agentName}...`);
    const setupResult = await setupPythonProject({ projectDir: appDir });
    if (setupResult.status === 'success') {
      onProgress?.(`Python environment ready for ${agentName}`);
    } else if (setupResult.status === 'uv_not_found') {
      onProgress?.(`Warning: uv not found — run "uv sync" manually in ${APP_DIR}/${agentName}`);
    } else {
      onProgress?.(`Warning: Python setup failed for ${agentName}: ${setupResult.error ?? setupResult.status}`);
    }
  }
}
