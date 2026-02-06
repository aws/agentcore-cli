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
