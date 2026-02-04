import type {
  AgentCoreCliMcpDefs,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  AwsDeploymentTarget,
  DeployedState,
} from '../../../schema';
import {
  AgentCoreCliMcpDefsSchema,
  AgentCoreMcpSpecSchema,
  AgentCoreProjectSpecSchema,
  AgentCoreRegionSchema,
  AwsDeploymentTargetsSchema,
  createValidatedDeployedStateSchema,
} from '../../../schema';
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  ConfigWriteError,
} from '../../errors';
import { detectAwsAccount } from '../../utils';
import { type PathConfig, PathResolver, findConfigRoot } from './path-resolver';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { type ZodType } from 'zod';

/**
 * Manages reading, writing, and validation of AgentCore configuration files
 */
export class ConfigIO {
  private readonly pathResolver: PathResolver;

  /**
   * Create a ConfigIO instance.
   * If no baseDir is provided, automatically discovers the project using findConfigRoot().
   */
  constructor(pathConfig?: Partial<PathConfig>) {
    // Auto-discover config root if no baseDir provided
    if (!pathConfig?.baseDir) {
      const discoveredRoot = findConfigRoot();
      if (discoveredRoot) {
        pathConfig = { ...pathConfig, baseDir: discoveredRoot };
      }
    }
    this.pathResolver = new PathResolver(pathConfig);
  }

  /**
   * Get the current path resolver
   */
  getPathResolver(): PathResolver {
    return this.pathResolver;
  }

  /**
   * Update the base directory for config files
   */
  setBaseDir(baseDir: string): void {
    this.pathResolver.setBaseDir(baseDir);
  }

  /**
   * Get the project root directory (parent of agentcore/)
   */
  getProjectRoot(): string {
    return this.pathResolver.getProjectRoot();
  }

  /**
   * Get the config root directory (the agentcore/ directory)
   */
  getConfigRoot(): string {
    return this.pathResolver.getBaseDir();
  }

  /**
   * Read and validate the project configuration.
   * Merges agentcore.json with mcp.json to provide a unified view.
   */
  async readProjectSpec(): Promise<AgentCoreProjectSpec> {
    const filePath = this.pathResolver.getAgentConfigPath();
    const projectSpec = await this.readAndValidate(filePath, 'AgentCore Project Config', AgentCoreProjectSpecSchema);

    // Merge MCP config if it exists
    if (this.configExists('mcp')) {
      const mcpSpec = await this.readMcpSpec();
      return { ...projectSpec, mcp: mcpSpec };
    }

    return projectSpec;
  }

  /**
   * Write and validate the project configuration file.
   * Only writes to agentcore.json (mcp is stored separately in mcp.json).
   */
  async writeProjectSpec(data: AgentCoreProjectSpec): Promise<void> {
    const filePath = this.pathResolver.getAgentConfigPath();
    // Strip mcp before writing - it's stored separately
    const { mcp: _, ...projectOnly } = data;
    await this.validateAndWrite(filePath, 'AgentCore Project Config', AgentCoreProjectSpecSchema, projectOnly);
  }

  /**
   * Read and validate the AWS configuration file.
   * Applies overrides following AWS SDK precedence:
   * - Account: from current credentials if AWS_PROFILE is set
   * - Region: AWS_REGION > AWS_DEFAULT_REGION > profile config > saved value
   */
  async readAWSDeploymentTargets(): Promise<AwsDeploymentTarget[]> {
    const filePath = this.pathResolver.getAWSTargetsConfigPath();
    let targets = await this.readAndValidate(filePath, 'AWS Targets', AwsDeploymentTargetsSchema);

    // Override account from credentials if AWS_PROFILE is set
    if (process.env.AWS_PROFILE) {
      const account = await detectAwsAccount();
      if (account) {
        targets = targets.map(t => ({ ...t, account }));
      }
    }

    // Override region from env vars
    const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (envRegion && AgentCoreRegionSchema.safeParse(envRegion).success) {
      return targets.map(t => ({ ...t, region: envRegion as AwsDeploymentTarget['region'] }));
    }

    // Check profile config for region
    try {
      const profile = process.env.AWS_PROFILE ?? 'default';
      const config = await loadSharedConfigFiles();
      const profileRegion = config.configFile?.[profile]?.region;
      if (profileRegion && AgentCoreRegionSchema.safeParse(profileRegion).success) {
        return targets.map(t => ({ ...t, region: profileRegion as AwsDeploymentTarget['region'] }));
      }
    } catch {
      // Config file not available - use current targets
    }

    return targets;
  }

  /**
   * Write and validate the AWS configuration file
   */
  async writeAWSDeploymentTargets(data: AwsDeploymentTarget[]): Promise<void> {
    const filePath = this.pathResolver.getAWSTargetsConfigPath();
    await this.validateAndWrite(filePath, 'AWS Targets', AwsDeploymentTargetsSchema, data);
  }

  /**
   * Read and validate the deployed state file.
   * Validates that all target keys exist in aws-targets.
   */
  async readDeployedState(): Promise<DeployedState> {
    const targets = await this.readAWSDeploymentTargets();
    const targetNames = targets.map(t => t.name);
    const schema = createValidatedDeployedStateSchema(targetNames);

    const filePath = this.pathResolver.getStatePath();
    return this.readAndValidate(filePath, 'State', schema);
  }

  /**
   * Write and validate the deployed state file.
   * Validates that all target keys exist in aws-targets.
   */
  async writeDeployedState(data: DeployedState): Promise<void> {
    const targets = await this.readAWSDeploymentTargets();
    const targetNames = targets.map(t => t.name);
    const schema = createValidatedDeployedStateSchema(targetNames);

    const filePath = this.pathResolver.getStatePath();
    await this.validateAndWrite(filePath, 'State', schema, data);
  }

  /**
   * Read and validate the MCP configuration file
   */
  async readMcpSpec(): Promise<AgentCoreMcpSpec> {
    const filePath = this.pathResolver.getMcpConfigPath();
    return this.readAndValidate(filePath, 'MCP Config', AgentCoreMcpSpecSchema);
  }

  /**
   * Write and validate the MCP configuration file
   */
  async writeMcpSpec(data: AgentCoreMcpSpec): Promise<void> {
    const filePath = this.pathResolver.getMcpConfigPath();
    await this.validateAndWrite(filePath, 'MCP Config', AgentCoreMcpSpecSchema, data);
  }

  /**
   * Read and validate the MCP definitions file
   */
  async readMcpDefs(): Promise<AgentCoreCliMcpDefs> {
    const filePath = this.pathResolver.getMcpDefsPath();
    return this.readAndValidate(filePath, 'MCP Definitions', AgentCoreCliMcpDefsSchema);
  }

  /**
   * Write and validate the MCP definitions file
   */
  async writeMcpDefs(data: AgentCoreCliMcpDefs): Promise<void> {
    const filePath = this.pathResolver.getMcpDefsPath();
    await this.validateAndWrite(filePath, 'MCP Definitions', AgentCoreCliMcpDefsSchema, data);
  }

  /**
   * Check if the base directory exists
   */
  baseDirExists(): boolean {
    return existsSync(this.pathResolver.getBaseDir());
  }

  /**
   * Check if a specific config file exists
   */
  configExists(type: 'project' | 'awsTargets' | 'state' | 'mcp' | 'mcpDefs'): boolean {
    const pathMap = {
      project: this.pathResolver.getAgentConfigPath(),
      awsTargets: this.pathResolver.getAWSTargetsConfigPath(),
      state: this.pathResolver.getStatePath(),
      mcp: this.pathResolver.getMcpConfigPath(),
      mcpDefs: this.pathResolver.getMcpDefsPath(),
    };
    return existsSync(pathMap[type]);
  }

  /**
   * Initialize the base directory and CLI system subdirectory
   */
  async initializeBaseDir(): Promise<void> {
    const baseDir = this.pathResolver.getBaseDir();
    const cliSystemDir = this.pathResolver.getCliSystemDir();
    try {
      await mkdir(baseDir, { recursive: true });
      await mkdir(cliSystemDir, { recursive: true });
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error('Unknown error');
      throw new ConfigWriteError(baseDir, normalizedError);
    }
  }

  /**
   * Generic read and validate method
   */
  private async readAndValidate<T>(filePath: string, fileType: string, schema: ZodType<T>): Promise<T> {
    // Check if file exists
    if (!existsSync(filePath)) {
      throw new ConfigNotFoundError(filePath, fileType);
    }

    // Read file
    let fileContent: string;
    try {
      fileContent = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error('Unknown error');
      throw new ConfigReadError(filePath, normalizedError);
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error('Invalid JSON');
      throw new ConfigParseError(filePath, normalizedError);
    }

    // Validate with Zod schema
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigValidationError(filePath, fileType, result.error);
    }

    return result.data;
  }

  /**
   * Generic validate and write method
   */
  private async validateAndWrite<T>(filePath: string, fileType: string, schema: ZodType<T>, data: T): Promise<void> {
    // Validate data with Zod schema
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ConfigValidationError(filePath, fileType, result.error);
    }

    // Ensure directory exists
    const dir = dirname(filePath);
    try {
      await mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error('Unknown error');
      throw new ConfigWriteError(filePath, normalizedError);
    }

    // Write file with pretty formatting
    try {
      const jsonContent = JSON.stringify(result.data, null, 2);
      await writeFile(filePath, jsonContent, 'utf-8');
    } catch (err: unknown) {
      const normalizedError = err instanceof Error ? err : new Error('Unknown error');
      throw new ConfigWriteError(filePath, normalizedError);
    }
  }
}

/**
 * Create a new ConfigIO instance
 */
export function createConfigIO(pathConfig?: Partial<PathConfig>): ConfigIO {
  return new ConfigIO(pathConfig);
}
