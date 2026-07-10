import { isValidDockerfilePath } from '../schema';
import { join } from 'path';

// Re-export all schema constants from schema
export * from '../schema';

// Configuration directory and file names
export const CONFIG_DIR = 'agentcore';

// Application code directory (for generated agents and MCP tools)
export const APP_DIR = 'app';
export const MCP_APP_SUBDIR = 'mcp';

// Harnesses directory
export const HARNESS_DIR = 'harnesses';

// CLI system subdirectory (inside CONFIG_DIR)
export const CLI_SYSTEM_DIR = '.cli';
export const CLI_LOGS_DIR = 'logs';

export const CONFIG_FILES = {
  AGENT_ENV: 'agentcore.json',
  AWS_TARGETS: 'aws-targets.json',
  DEPLOYED_STATE: 'deployed-state.json',
  MCP_DEFS: 'mcp-defs.json',
} as const;

/** Environment file for secrets (API keys, etc.) - local only, not committed */
export const ENV_FILE = '.env.local';

/**
 * Get the artifact zip name for a bundle
 * @param name Name for the artifact (agent or tool name)
 * @returns <name>.zip
 */
export function getArtifactZipName(name: string): string {
  return `${name}.zip`;
}

export const UV_INSTALL_HINT =
  'Install uv from https://github.com/astral-sh/uv#installation and ensure it is on your PATH.';
export const NPM_INSTALL_HINT = 'Install npm from https://nodejs.org/ and ensure it is on your PATH.';
export const DEFAULT_PYTHON_PLATFORM = 'aarch64-manylinux2014';

// Container constants
export const ONE_GB = 1024 * 1024 * 1024;
export const DOCKERFILE_NAME = 'Dockerfile';
export const CONTAINER_INTERNAL_PORT = 8080;

/** Supported container runtimes in order of preference. */
export type ContainerRuntime = 'docker' | 'podman' | 'finch';
export const CONTAINER_RUNTIMES: ContainerRuntime[] = ['docker', 'podman', 'finch'];

/**
 * Resolve the Dockerfile path against the Docker build context.
 * @param buildContext - The build context directory (`buildContextPath` when set, else `codeLocation`)
 * @param dockerfile - Dockerfile name or relative subpath within the context (default: 'Dockerfile')
 *
 * `dockerfile` may be a filename ('Dockerfile') or a forward-slash relative subpath
 * ('docker/Dockerfile'); absolute paths, backslashes, and `..` traversal are rejected so it can
 * never escape the build context.
 */
export function getDockerfilePath(buildContext: string, dockerfile?: string): string {
  const name = dockerfile ?? DOCKERFILE_NAME;
  if (!isValidDockerfilePath(name)) {
    throw new Error(
      `Invalid dockerfile path "${name}": must be a relative path within the build context (a filename or ` +
        `forward-slash subpath; no leading slash, backslash, empty segments, or ".." traversal)`
    );
  }
  return join(buildContext, name);
}
