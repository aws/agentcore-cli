/**
 * External dependency version checks.
 */
import { checkSubprocess, isWindows, runSubprocessCapture } from '../../lib';
import type { AgentCoreProjectSpec, TargetLanguage } from '../../schema';
import { detectContainerRuntime } from './detect';
import { NODE_MIN_VERSION, formatSemVer, parseSemVer, semVerGte } from './versions';

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
 * Check if the project has any Python CodeZip agents that require uv.
 */
export function requiresUv(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.agents.some(agent => agent.build === 'CodeZip');
}

/**
 * Check if the project has any Container agents that benefit from a local container runtime.
 */
export function requiresContainerRuntime(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.agents.some(agent => agent.build === 'Container');
}

/**
 * Result of dependency version checks.
 */
export interface DependencyCheckResult {
  passed: boolean;
  nodeCheck: VersionCheckResult;
  uvCheck: VersionCheckResult | null;
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
      "'aws' CLI not found. Required for 'aws sso login' and profile configuration. Install from https://aws.amazon.com/cli/"
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
