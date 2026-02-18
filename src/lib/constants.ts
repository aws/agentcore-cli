import { join } from 'path';

// Re-export all schema constants from schema
export * from '../schema';

// Configuration directory and file names
export const CONFIG_DIR = 'agentcore';

// Application code directory (for generated agents and MCP tools)
export const APP_DIR = 'app';
export const MCP_APP_SUBDIR = 'mcp';

// CLI system subdirectory (inside CONFIG_DIR)
export const CLI_SYSTEM_DIR = '.cli';
export const CLI_LOGS_DIR = 'logs';

export const CONFIG_FILES = {
  AGENT_ENV: 'agentcore.json',
  AWS_TARGETS: 'aws-targets.json',
  DEPLOYED_STATE: 'deployed-state.json',
  MCP: 'mcp.json',
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

/** Platform-aware start hints for container runtimes. */
export const START_HINTS: Record<ContainerRuntime, string> = {
  docker:
    process.platform === 'win32'
      ? 'Start Docker Desktop or run: Start-Service docker'
      : 'Start Docker Desktop or run: sudo systemctl start docker',
  podman: 'Run: podman machine start',
  finch: 'Run: finch vm init && finch vm start',
};

/**
 * Get the Dockerfile path for a given code location.
 */
export function getDockerfilePath(codeLocation: string): string {
  return join(codeLocation, DOCKERFILE_NAME);
}
