import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR, CONFIG_FILES as _CONFIG_FILES } from '../../constants';
import { NoProjectError } from '../../errors';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

export const CONFIG_FILES = _CONFIG_FILES;

/**
 * Get the working directory where the user invoked the CLI.
 *
 * When running via npm/bun scripts (e.g., `npm run cli`), the package manager
 * changes process.cwd() to the package root. INIT_CWD preserves the original
 * directory where the user ran the command.
 *
 * For globally installed CLIs, INIT_CWD is not set, so we fall back to process.cwd().
 */
export function getWorkingDirectory(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

/**
 * Find the config root, throwing NoProjectError if not found.
 * Use this when a project is required to proceed.
 */
export function requireConfigRoot(startDir?: string): string {
  const configRoot = findConfigRoot(startDir);
  if (!configRoot) {
    throw new NoProjectError();
  }
  return configRoot;
}

/**
 * Session-level project root override.
 * Set this after init creates a project so subsequent discovery finds it.
 */
let sessionProjectRoot: string | null = null;

/**
 * Set the project root for the current session.
 * Call this after init creates a new project at cwd/projectName/.
 * Subsequent calls to findConfigRoot() will check this location first.
 */
export function setSessionProjectRoot(projectRoot: string): void {
  sessionProjectRoot = projectRoot;
}

/**
 * Get the current session project root, if set.
 */
export function getSessionProjectRoot(): string | null {
  return sessionProjectRoot;
}

/**
 * Configuration for where AgentCore files are stored
 */
export interface PathConfig {
  /** Base directory for all AgentCore files */
  baseDir: string;
}

/**
 * Check if a directory is a valid AgentCore config directory.
 * A valid config directory contains agentcore.json.
 */
function isValidConfigDir(configPath: string): boolean {
  return existsSync(join(configPath, _CONFIG_FILES.AGENT_ENV));
}

/**
 * Walk up the directory tree from startDir looking for an agentcore directory.
 * If a session project was set (via setSessionProjectRoot), checks there first.
 * Returns the path to the agentcore directory if found, or null if not found.
 */
export function findConfigRoot(startDir: string = getWorkingDirectory()): string | null {
  // Check session project first (set after init creates a project)
  if (sessionProjectRoot) {
    const sessionConfigPath = join(sessionProjectRoot, CONFIG_DIR);
    if (existsSync(sessionConfigPath) && isValidConfigDir(sessionConfigPath)) {
      return sessionConfigPath;
    }
  }

  // Fall back to walking up the directory tree
  let currentDir = startDir;

  while (true) {
    const configPath = join(currentDir, CONFIG_DIR);
    if (existsSync(configPath) && isValidConfigDir(configPath)) {
      return configPath;
    }

    const parentDir = dirname(currentDir);
    // Reached filesystem root
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Get the project root directory (parent of agentcore/).
 * Returns null if no project is found.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  const configRoot = findConfigRoot(startDir);
  return configRoot ? dirname(configRoot) : null;
}

/**
 * Default configuration uses agentcore/ in current working directory.
 */
export const DEFAULT_PATH_CONFIG: PathConfig = {
  baseDir: join(getWorkingDirectory(), CONFIG_DIR),
};

/**
 * Utility class for resolving AgentCore file paths
 */
export class PathResolver {
  private config: PathConfig;

  constructor(config?: Partial<PathConfig>) {
    this.config = {
      ...DEFAULT_PATH_CONFIG,
      ...config,
    };
  }

  /**
   * Get the base directory path (the agentcore/ config directory)
   */
  getBaseDir(): string {
    return this.config.baseDir;
  }

  /**
   * Get the project root directory (parent of agentcore/)
   */
  getProjectRoot(): string {
    return dirname(this.config.baseDir);
  }

  /**
   * Get the path to the agent config file (agentcore.json)
   */
  getAgentConfigPath(): string {
    return join(this.config.baseDir, CONFIG_FILES.AGENT_ENV);
  }

  /**
   * Get the path to the AWS targets config file (aws-targets.json)
   */
  getAWSTargetsConfigPath(): string {
    return join(this.config.baseDir, CONFIG_FILES.AWS_TARGETS);
  }

  /**
   * Get the path to the CLI system directory (agentcore/.cli/)
   */
  getCliSystemDir(): string {
    return join(this.config.baseDir, CLI_SYSTEM_DIR);
  }

  /**
   * Get the path to the logs directory (agentcore/.cli/logs/)
   */
  getLogsDir(): string {
    return join(this.config.baseDir, CLI_SYSTEM_DIR, CLI_LOGS_DIR);
  }

  /**
   * Get the path to the invoke logs directory (agentcore/.cli/logs/invoke/)
   */
  getInvokeLogsDir(): string {
    return join(this.config.baseDir, CLI_SYSTEM_DIR, CLI_LOGS_DIR, 'invoke');
  }

  /**
   * Get the path to the deployed state file (agentcore/.cli/deployed-state.json)
   */
  getStatePath(): string {
    return join(this.config.baseDir, CLI_SYSTEM_DIR, CONFIG_FILES.DEPLOYED_STATE);
  }

  /**
   * Get the path to the MCP definitions file (mcp-defs.json)
   */
  getMcpDefsPath(): string {
    return join(this.config.baseDir, CONFIG_FILES.MCP_DEFS);
  }

  /**
   * Update the base directory
   */
  setBaseDir(baseDir: string): void {
    this.config.baseDir = baseDir;
  }
}
