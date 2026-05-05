import type { AgentCoreCliMcpDefs, AgentCoreProjectSpec, AwsDeploymentTarget, DeployedState } from '../../../schema';
import {
  AgentCoreCliMcpDefsSchema,
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
import { NoProjectError } from '../../errors';
import { detectAwsAccount } from '../../utils';
import { type PathConfig, PathResolver, findConfigRoot } from './path-resolver';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { type ZodType } from 'zod';

/** Supported schema versions. Extend this union as new versions are published. */
type SchemaVersion = 1;

export function getSchemaUrlForVersion(version: SchemaVersion): string {
  return `https://schema.agentcore.aws.dev/v${version}/agentcore.json`;
}

/**
 * Manages reading, writing, and validation of AgentCore configuration files
 */
export class ConfigIO {
  private readonly pathResolver: PathResolver;
  private readonly projectDiscovered: boolean;

  /**
   * Create a ConfigIO instance.
   * If no baseDir is provided, automatically discovers the project using findConfigRoot().
   */
  constructor(pathConfig?: Partial<PathConfig>) {
    // Track if baseDir was explicitly provided
    const baseDirProvided = !!pathConfig?.baseDir;

    // Auto-discover config root if no baseDir provided
    if (!baseDirProvided) {
      const discoveredRoot = findConfigRoot();
      if (discoveredRoot) {
        pathConfig = { ...pathConfig, baseDir: discoveredRoot };
        this.projectDiscovered = true;
      } else {
        // No project found and no explicit baseDir - mark as not discovered
        this.projectDiscovered = false;
      }
    } else {
      // baseDir was explicitly provided (e.g., during project creation)
      this.projectDiscovered = true;
    }

    this.pathResolver = new PathResolver(pathConfig);
  }

  /**
   * Check if this ConfigIO is associated with a discovered or explicitly configured project.
   * Returns false if no baseDir was provided and no project was found via auto-discovery.
   */
  hasProject(): boolean {
    return this.projectDiscovered;
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
   */
  async readProjectSpec(): Promise<AgentCoreProjectSpec> {
    const filePath = this.pathResolver.getAgentConfigPath();
    return this.readAndValidate(filePath, 'AgentCore Project Config', AgentCoreProjectSpecSchema);
  }

  /**
   * Write and validate the project configuration file.
   */
  async writeProjectSpec(data: AgentCoreProjectSpec): Promise<void> {
    const filePath = this.pathResolver.getAgentConfigPath();
    // TODO: extend this to all resource arrays so empty defaults never pollute agentcore.json
    const cleaned = { ...data };
    if (cleaned.configBundles?.length === 0) delete (cleaned as Record<string, unknown>).configBundles;
    if (cleaned.abTests?.length === 0) delete (cleaned as Record<string, unknown>).abTests;
    if (cleaned.httpGateways?.length === 0) delete (cleaned as Record<string, unknown>).httpGateways;
    await this.validateAndWrite(filePath, 'AgentCore Project Config', AgentCoreProjectSpecSchema, cleaned);
  }

  /**
   * Read and validate the AWS configuration file.
   * Region is preserved as saved. Use resolveAWSDeploymentTargets() for environment/profile overrides.
   * TODO: Account is still overridden via AWS_PROFILE — consider moving to resolveAWSDeploymentTargets() for consistency.
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

    return targets;
  }

  /**
   * Read AWS deployment targets with region fallback from environment/profile.
   * Region precedence: saved value > AWS_REGION > AWS_DEFAULT_REGION > profile config.
   * Environment/profile region is only used as a fallback when no region is saved in aws-targets.json.
   */
  async resolveAWSDeploymentTargets(): Promise<AwsDeploymentTarget[]> {
    const targets = await this.readAWSDeploymentTargets();

    // Only resolve region for targets that don't already have one saved
    const fallbackRegion = await this.resolveRegionFallback();
    if (!fallbackRegion) {
      return targets;
    }

    return targets.map(t => (t.region ? t : { ...t, region: fallbackRegion as AwsDeploymentTarget['region'] }));
  }

  /**
   * Resolve a fallback region from environment variables or AWS profile config.
   */
  private async resolveRegionFallback(): Promise<string | undefined> {
    // Check env vars first
    const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (envRegion && AgentCoreRegionSchema.safeParse(envRegion).success) {
      return envRegion;
    }

    // Check profile config
    try {
      const profile = process.env.AWS_PROFILE ?? 'default';
      const config = await loadSharedConfigFiles();
      const profileRegion = config.configFile?.[profile]?.region;
      if (profileRegion && AgentCoreRegionSchema.safeParse(profileRegion).success) {
        return profileRegion;
      }
    } catch {
      // Config file not available
    }

    return undefined;
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
  configExists(type: 'project' | 'awsTargets' | 'state' | 'mcpDefs'): boolean {
    const pathMap = {
      project: this.pathResolver.getAgentConfigPath(),
      awsTargets: this.pathResolver.getAWSTargetsConfigPath(),
      state: this.pathResolver.getStatePath(),
      mcpDefs: this.pathResolver.getMcpDefsPath(),
    };
    return existsSync(pathMap[type]);
  }

  /**
   * Initialize the base directory and CLI system subdirectory.
   * Requires that a baseDir was explicitly provided or a project was discovered.
   */
  async initializeBaseDir(): Promise<void> {
    // Prevent creating directories when no project was configured
    if (!this.projectDiscovered) {
      throw new NoProjectError();
    }

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
    // Prevent writing to non-existent projects
    if (!this.projectDiscovered) {
      throw new NoProjectError();
    }

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
