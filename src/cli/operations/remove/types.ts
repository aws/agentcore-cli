import type { AgentCoreCliMcpDefs, AgentCoreMcpSpec, AgentCoreProjectSpec, AwsDeploymentTarget } from '../../../schema';

/**
 * Represents a change to a schema file for the diff preview.
 */
export interface SchemaChange {
  file: string;
  before: unknown;
  after: unknown;
}

/**
 * Result of computing what will be removed.
 */
export interface RemovalPreview {
  /** Human-readable summary of what will be removed */
  summary: string[];
  /** Directories that will be deleted */
  directoriesToDelete: string[];
  /** Schema changes for diff preview */
  schemaChanges: SchemaChange[];
}

/**
 * Result of a removal operation.
 */
export type RemovalResult = { ok: true } | { ok: false; error: string };

/**
 * Snapshot of all schemas before removal (for diff computation).
 */
export interface SchemaSnapshot {
  projectSpec: AgentCoreProjectSpec;
  mcpSpec: AgentCoreMcpSpec;
  mcpDefs: AgentCoreCliMcpDefs;
  awsTargets: AwsDeploymentTarget[];
}
