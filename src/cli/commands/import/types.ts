import type { Result } from '../../../lib/result';
import type {
  AgentCoreProjectSpec,
  AuthorizerConfig,
  AwsDeploymentTarget,
  RuntimeAuthorizerType,
} from '../../../schema';
import type { ExecLogger } from '../../logging';
import type { ImportedResource, ProjectContext } from './import-utils';

/**
 * Parsed representation of a starter toolkit agent from .bedrock_agentcore.yaml.
 */
export interface ParsedStarterToolkitAgent {
  name: string;
  entrypoint: string;
  build: 'CodeZip' | 'Container';
  runtimeVersion?: string;
  language: 'python' | 'typescript';
  sourcePath?: string;
  networkMode: 'PUBLIC' | 'VPC';
  networkConfig?: { subnets: string[]; securityGroups: string[] };
  protocol: 'HTTP' | 'MCP' | 'A2A' | 'AGUI';
  enableOtel: boolean;
  /** Physical agent runtime ID from the starter toolkit deployment */
  physicalAgentId?: string;
  /** Physical agent runtime ARN */
  physicalAgentArn?: string;
  /** Authorizer type for inbound requests */
  authorizerType?: RuntimeAuthorizerType;
  /** Authorizer configuration (Custom JWT) */
  authorizerConfiguration?: AuthorizerConfig;
  /** ARN of the execution role from the starter toolkit deployment */
  executionRoleArn?: string;
}

/**
 * Parsed representation of a starter toolkit memory config.
 */
export interface ParsedStarterToolkitMemory {
  name: string;
  mode: 'STM_ONLY' | 'STM_AND_LTM' | 'NO_MEMORY';
  eventExpiryDays: number;
  /** Physical memory ID from the starter toolkit deployment */
  physicalMemoryId?: string;
  /** Physical memory ARN */
  physicalMemoryArn?: string;
}

/**
 * Parsed representation of a starter toolkit credential provider.
 */
export interface ParsedStarterToolkitCredential {
  /** Credential provider name in Identity service */
  name: string;
  /** Provider type: cognito, github, google, salesforce, or api_key */
  providerType: 'oauth' | 'api_key';
}

/**
 * Full parsed result from the YAML file.
 */
export interface ParsedStarterToolkitConfig {
  defaultAgent?: string;
  agents: ParsedStarterToolkitAgent[];
  memories: ParsedStarterToolkitMemory[];
  credentials: ParsedStarterToolkitCredential[];
  awsTarget: {
    account?: string;
    region?: string;
  };
}

/**
 * Resource types supported by the import subcommands.
 * Use the array for runtime checks (e.g., IMPORTABLE_RESOURCES.includes(x)).
 */
export const IMPORTABLE_RESOURCES = ['runtime', 'memory', 'evaluator', 'online-eval', 'gateway'] as const;
export type ImportableResourceType = (typeof IMPORTABLE_RESOURCES)[number];

/**
 * Resource to be imported via CloudFormation IMPORT change set.
 */
export interface ResourceToImport {
  resourceType: string;
  logicalResourceId: string;
  resourceIdentifier: Record<string, string>;
}

/**
 * Result of the import command.
 */
export type ImportResult = Result<{
  projectSpec?: AgentCoreProjectSpec;
  importedAgents?: string[];
  importedMemories?: string[];
  stackName?: string;
}> & { logPath?: string };

/**
 * Result for single-resource import (runtime, memory, evaluator, etc.).
 */
export type ImportResourceResult = Result<{
  resourceId?: string;
}> & { resourceType: ImportableResourceType; resourceName: string; logPath?: string };

/**
 * Options shared across import subcommands.
 */
export interface ImportResourceOptions {
  arn?: string;
  target?: string;
  name?: string;
  yes?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Extended options for runtime import (includes source code fields).
 */
export interface RuntimeImportOptions extends ImportResourceOptions {
  code?: string;
  entrypoint?: string;
}

// ============================================================================
// Generic Resource Import Descriptor
// ============================================================================

/**
 * Context passed to the beforeConfigWrite hook.
 */
export interface BeforeWriteContext<TDetail> {
  detail: TDetail;
  localName: string;
  projectSpec: AgentCoreProjectSpec;
  ctx: ProjectContext;
  target: AwsDeploymentTarget;
  options: ImportResourceOptions;
  onProgress: (msg: string) => void;
  logger: ExecLogger;
}

/**
 * Descriptor that defines resource-type-specific behavior for the generic import orchestrator.
 *
 * TDetail: The AWS "get" API response type (e.g., GetEvaluatorResult)
 * TSummary: The AWS "list" API response item type (e.g., EvaluatorSummary)
 */
export interface ResourceImportDescriptor<TDetail, TSummary> {
  /** The importable resource type identifier. */
  resourceType: ImportableResourceType;

  /** Human-readable resource type name for log messages (e.g., "evaluator"). */
  displayName: string;

  /** Logger command name (e.g., 'import-evaluator'). */
  logCommand: string;

  // ---- AWS API ----

  /** List all resources of this type in the region. */
  listResources: (region: string) => Promise<TSummary[]>;

  /** Get full details for a single resource by ID. */
  getDetail: (region: string, resourceId: string) => Promise<TDetail>;

  /** Extract the resource ID from an ARN. */
  parseResourceId: (arn: string, target: { region: string; account: string }) => string;

  // ---- List display ----

  /** Extract ID from a summary item. */
  extractSummaryId: (summary: TSummary) => string;

  /** Format a summary item for console display in multi-result listing. */
  formatListItem: (summary: TSummary, index: number) => string;

  /** Format the auto-select message when exactly 1 result is found. */
  formatAutoSelectMessage: (summary: TSummary) => string;

  // ---- Detail inspection ----

  /** Extract the canonical name from the detail response. */
  extractDetailName: (detail: TDetail) => string;

  /** Extract the ARN from the detail response. */
  extractDetailArn: (detail: TDetail) => string;

  /** The expected "ready" status value (e.g., 'READY' for runtime, 'ACTIVE' for others). */
  readyStatus: string;

  /** Extract the current status from the detail response. */
  extractDetailStatus: (detail: TDetail) => string;

  // ---- Config ----

  /** Get the array of existing resource names from the project spec. */
  getExistingNames: (projectSpec: AgentCoreProjectSpec) => string[];

  /**
   * Convert the AWS detail to local spec and add it to the project spec.
   * Called after beforeConfigWrite — descriptor factories may rely on state set during that hook.
   */
  addToProjectSpec: (detail: TDetail, localName: string, projectSpec: AgentCoreProjectSpec) => void;

  // ---- CFN template matching ----

  /** CloudFormation resource type string. */
  cfnResourceType: string;

  /** CFN property name used for name-based lookup. */
  cfnNameProperty: string;

  /** CFN resource identifier key for the import. */
  cfnIdentifierKey: string;

  // ---- Deployed state ----

  /** Build the deployed-state entry for this resource. */
  buildDeployedStateEntry: (localName: string, resourceId: string, detail: TDetail) => ImportedResource;

  // ---- Optional hooks ----

  /**
   * Called after detail fetch + name validation but before config write.
   * Always runs before addToProjectSpec — descriptor factories can use this
   * to set closed-over state that addToProjectSpec later reads.
   * Return an ImportResourceResult to abort, or void to continue.
   */
  beforeConfigWrite?: (ctx: BeforeWriteContext<TDetail>) => Promise<ImportResourceResult | void>;

  /** Cleanup on rollback (e.g., runtime deletes copied app directory). */
  rollbackExtra?: () => Promise<void>;
}
