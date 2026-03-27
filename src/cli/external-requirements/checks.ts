/**
 * External dependency version checks.
 */
import { checkSubprocess, isWindows, runSubprocessCapture } from '../../lib';
import type { AgentCoreProjectSpec, TargetLanguage } from '../../schema';
import { detectContainerRuntime } from './detect';
import { AWS_CLI_MIN_VERSION, NODE_MIN_VERSION, formatSemVer, parseSemVer, semVerGte } from './versions';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Result of a version check.
 */
export interface VersionCheckResult {
  satisfied: boolean;
  current: string | null;
  required: string;
  binary: string;
}

/**
 * Extract version from `node --version` output.
 * Expected format: "v18.17.0" or "v20.10.0"
 */
function parseNodeVersion(output: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec(output.trim());
  return match?.[1] ?? null;
}

/**
 * Check that Node.js meets minimum version requirement.
 */
export async function checkNodeVersion(): Promise<VersionCheckResult> {
  const required = formatSemVer(NODE_MIN_VERSION);

  const result = await runSubprocessCapture('node', ['--version']);
  if (result.code !== 0) {
    return { satisfied: false, current: null, required, binary: 'node' };
  }

  const versionStr = parseNodeVersion(result.stdout);
  if (!versionStr) {
    return { satisfied: false, current: null, required, binary: 'node' };
  }

  const current = parseSemVer(versionStr);
  if (!current) {
    return { satisfied: false, current: versionStr, required, binary: 'node' };
  }

  return {
    satisfied: semVerGte(current, NODE_MIN_VERSION),
    current: versionStr,
    required,
    binary: 'node',
  };
}

/**
 * Check that uv is available in PATH.
 */
export async function checkUvVersion(): Promise<VersionCheckResult> {
  const result = await runSubprocessCapture('uv', ['--version']);
  if (result.code !== 0) {
    return { satisfied: false, current: null, required: 'any', binary: 'uv' };
  }

  // Extract version for display in preflight logs
  const match = /uv\s+(\d+\.\d+\.\d+)/.exec(result.stdout.trim());
  const current = match?.[1] ?? 'unknown';

  return { satisfied: true, current, required: 'any', binary: 'uv' };
}

const AWS_CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';

/**
 * Extract version from `aws --version` output.
 * Expected format: "aws-cli/2.32.0 Python/3.11.6 Darwin/23.3.0 ..."
 */
function parseAwsCliVersion(output: string): string | null {
  const match = /aws-cli\/(\d+\.\d+\.\d+)/.exec(output.trim());
  return match?.[1] ?? null;
}

/**
 * Check that AWS CLI meets minimum version requirement for `aws login`.
 */
export async function checkAwsCliVersion(): Promise<VersionCheckResult> {
  const required = formatSemVer(AWS_CLI_MIN_VERSION);

  const result = await runSubprocessCapture('aws', ['--version']);
  if (result.code !== 0) {
    return { satisfied: false, current: null, required, binary: 'aws' };
  }

  const versionStr = parseAwsCliVersion(result.stdout);
  if (!versionStr) {
    return { satisfied: false, current: null, required, binary: 'aws' };
  }

  const current = parseSemVer(versionStr);
  if (!current) {
    return { satisfied: false, current: versionStr, required, binary: 'aws' };
  }

  return {
    satisfied: semVerGte(current, AWS_CLI_MIN_VERSION),
    current: versionStr,
    required,
    binary: 'aws',
  };
}

/** Cached result for getAwsLoginGuidance */
let _awsLoginGuidance: string | null = null;

/**
 * Get version-aware guidance for authenticating with AWS.
 * Checks if AWS CLI is installed and whether it supports `aws login`.
 * Result is cached for the lifetime of the process.
 */
export async function getAwsLoginGuidance(): Promise<string> {
  if (_awsLoginGuidance) return _awsLoginGuidance;

  const check = await checkAwsCliVersion();

  if (check.current === null) {
    // AWS CLI not installed
    _awsLoginGuidance = `Install AWS CLI (v${formatSemVer(AWS_CLI_MIN_VERSION)}+) from ${AWS_CLI_INSTALL_URL} and run: aws login`;
  } else if (!check.satisfied) {
    // AWS CLI installed but too old for `aws login`
    _awsLoginGuidance = `Update AWS CLI from v${check.current} to v${formatSemVer(AWS_CLI_MIN_VERSION)}+ (${AWS_CLI_INSTALL_URL}) and run: aws login`;
  } else {
    // AWS CLI is new enough
    _awsLoginGuidance = 'Run: aws login';
  }

  return _awsLoginGuidance;
}

/**
 * Format a version check failure as a user-friendly error message.
 */
export function formatVersionError(result: VersionCheckResult): string {
  if (result.current === null) {
    if (result.binary === 'uv') {
      return `'uv' not found. Install from https://github.com/astral-sh/uv#installation`;
    }
    return `'${result.binary}' not found. Install ${result.binary} >= ${result.required}`;
  }
  return `${result.binary} ${result.current} is below minimum required version ${result.required}`;
}

/**
 * Result of checking npm cache directory ownership.
 */
export interface NpmCacheCheckResult {
  /** true when the cache dir doesn't exist or is owned by the current user. */
  satisfied: boolean;
  /** Owner of ~/.npm, or null if the directory doesn't exist. */
  owner: string | null;
  /** The cache directory path that was checked. */
  cacheDir: string;
}

/**
 * Check that the npm cache directory (~/.npm) is owned by the current user.
 *
 * A previous `sudo npm install` can leave root-owned files in the cache,
 * causing EACCES errors on subsequent `npm install` runs.
 * Skipped on Windows where file ownership semantics differ.
 */
export async function checkNpmCacheOwnership(): Promise<NpmCacheCheckResult> {
  const cacheDir = join(homedir(), '.npm');

  // Skip on Windows - file ownership model is different
  if (isWindows) {
    return { satisfied: true, owner: null, cacheDir };
  }

  try {
    const stats = await stat(cacheDir);
    const currentUid = process.getuid?.();
    if (currentUid === undefined) {
      // getuid not available (e.g. some non-POSIX runtimes) — skip check
      return { satisfied: true, owner: null, cacheDir };
    }

    if (stats.uid !== currentUid) {
      // Resolve owner name for the error message
      const ownerResult = await runSubprocessCapture('id', ['-un', String(stats.uid)]);
      const owner = ownerResult.code === 0 ? ownerResult.stdout.trim() : `uid=${stats.uid}`;
      return { satisfied: false, owner, cacheDir };
    }

    return { satisfied: true, owner: null, cacheDir };
  } catch {
    // Directory doesn't exist yet — not a problem
    return { satisfied: true, owner: null, cacheDir };
  }
}

/**
 * Format an npm cache ownership failure as a user-friendly error message.
 */
export function formatNpmCacheError(result: NpmCacheCheckResult): string {
  return (
    `npm cache directory (${result.cacheDir}) is owned by '${result.owner}' instead of the current user. ` +
    `This was likely caused by a previous 'sudo npm install'. ` +
    `Fix: sudo chown -R $(whoami) ${result.cacheDir}`
  );
}

/**
 * Check if the project has any Python CodeZip agents that require uv.
 */
export function requiresUv(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.runtimes.some(agent => agent.build === 'CodeZip');
}

/**
 * Check if the project has any Container agents that benefit from a local container runtime.
 */
export function requiresContainerRuntime(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.runtimes.some(agent => agent.build === 'Container');
}

/**
 * Result of dependency version checks.
 */
export interface DependencyCheckResult {
  passed: boolean;
  nodeCheck: VersionCheckResult;
  uvCheck: VersionCheckResult | null;
  npmCacheCheck: NpmCacheCheckResult;
  containerRuntimeAvailable: boolean;
  errors: string[];
}

/**
 * Check that required dependency versions are met.
 * - Node >= 18 is always required for CDK synth
 * - uv is required when there are Python CodeZip agents
 */
export async function checkDependencyVersions(projectSpec: AgentCoreProjectSpec): Promise<DependencyCheckResult> {
  const errors: string[] = [];

  // Always check Node version (required for CDK synth)
  const nodeCheck = await checkNodeVersion();
  if (!nodeCheck.satisfied) {
    errors.push(formatVersionError(nodeCheck));
  }

  // Check uv only if there are Python CodeZip agents
  let uvCheck: VersionCheckResult | null = null;
  if (requiresUv(projectSpec)) {
    uvCheck = await checkUvVersion();
    if (!uvCheck.satisfied) {
      errors.push(formatVersionError(uvCheck));
    }
  }

  // Check npm cache ownership (root-owned cache causes EACCES on npm install)
  const npmCacheCheck = await checkNpmCacheOwnership();
  if (!npmCacheCheck.satisfied) {
    errors.push(formatNpmCacheError(npmCacheCheck));
  }

  // Check container runtime only if there are Container agents (warn only, not error)
  let containerRuntimeAvailable = true;
  if (requiresContainerRuntime(projectSpec)) {
    const info = await detectContainerRuntime();
    containerRuntimeAvailable = info.runtime !== null;
    if (!info.runtime) {
      // This is a warning, not an error - deploy still works via CodeBuild
      // We don't add to errors[] since it's not blocking
    }
  }

  return {
    passed: errors.length === 0,
    nodeCheck,
    uvCheck,
    npmCacheCheck,
    containerRuntimeAvailable,
    errors,
  };
}

/**
 * Severity level for CLI tool checks.
 */
export type CheckSeverity = 'error' | 'warn';

/**
 * Result of checking a single CLI tool.
 */
export interface CliToolCheck {
  binary: string;
  severity: CheckSeverity;
  available: boolean;
  installHint?: string;
}

/**
 * Result of checking all CLI tools for project creation.
 */
export interface CliToolsCheckResult {
  passed: boolean; // true if no errors (warnings allowed)
  checks: CliToolCheck[];
  errors: string[];
  warnings: string[];
}

/**
 * Options for checkCreateDependencies.
 */
export interface CheckCreateDependenciesOptions {
  /** Language being used - determines if uv is required. Undefined = skip uv check */
  language?: TargetLanguage;
}

/**
 * Check availability of CLI tools required for project creation.
 * - uv: required for Python projects only (skipped if language is undefined or TypeScript)
 * - npm: required for CDK project (always)
 * - aws: optional, needed for deployment (warn only)
 */
export async function checkCreateDependencies(
  options: CheckCreateDependenciesOptions = {}
): Promise<CliToolsCheckResult> {
  const { language } = options;
  const checks: CliToolCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check uv (error if missing, only for Python)
  if (language === 'Python') {
    const uvAvailable = await checkBinaryAvailable('uv');
    checks.push({
      binary: 'uv',
      severity: 'error',
      available: uvAvailable,
      installHint: 'Install from https://github.com/astral-sh/uv#installation',
    });
    if (!uvAvailable) {
      errors.push("'uv' is required for Python projects. Install from https://github.com/astral-sh/uv#installation");
    }
  }

  // Check npm (error if missing)
  const npmAvailable = await checkBinaryAvailable('npm');
  checks.push({
    binary: 'npm',
    severity: 'error',
    available: npmAvailable,
    installHint: 'Install Node.js from https://nodejs.org/',
  });
  if (!npmAvailable) {
    errors.push("'npm' is required. Install Node.js from https://nodejs.org/");
  }

  // Check npm cache ownership (root-owned cache causes EACCES on npm install)
  if (npmAvailable) {
    const npmCacheCheck = await checkNpmCacheOwnership();
    if (!npmCacheCheck.satisfied) {
      errors.push(formatNpmCacheError(npmCacheCheck));
    }
  }

  // Check aws (warn if missing)
  const awsAvailable = await checkBinaryAvailable('aws');
  checks.push({
    binary: 'aws',
    severity: 'warn',
    available: awsAvailable,
    installHint: 'Install from https://aws.amazon.com/cli/',
  });
  if (!awsAvailable) {
    warnings.push(
      `'aws' CLI not found. Required for 'aws login'. Install v${formatSemVer(AWS_CLI_MIN_VERSION)}+ from ${AWS_CLI_INSTALL_URL}`
    );
  }

  return {
    passed: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}

/**
 * Check if a binary is available in PATH.
 * Uses multiple fallback strategies for cross-platform compatibility.
 */
async function checkBinaryAvailable(binary: string): Promise<boolean> {
  // Try multiple detection strategies
  const checks = [
    // Primary: use 'where' on Windows, 'which' on Unix
    () => (isWindows ? checkSubprocess('where', [binary]) : checkSubprocess('which', [binary])),
    // Fallback: try running with --version
    () => checkSubprocess(binary, ['--version']),
    // Fallback: try running with -v
    () => checkSubprocess(binary, ['-v']),
  ];

  for (const check of checks) {
    if (await check()) {
      return true;
    }
  }
  return false;
}
