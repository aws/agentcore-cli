import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import type { ProjectManager } from "../types";
import type { CoreOptions } from "../../../core/types";

export type ExecutionRoleSource = {
  roleArn: string;
  inlinePolicies: { name: string; document: Record<string, unknown> }[];
  managedPolicyArns: string[];
  permissionsBoundaryArn?: string;
  tags: Record<string, string>;
};

export interface CoreExecutionRoleSourceReader {
  read(roleArn: string, options: CoreOptions): Promise<ExecutionRoleSource>;
}

export type MemoryRetrievalConfig = Record<
  string,
  { topK?: number; relevanceScore?: number; strategyId?: string }
>;

/** Dependencies for `agentcore export` handlers. */
export type ExportProjectResourceConfig = {
  projectManager: ProjectManager;
  /** Service clients, for exporting a harness fetched by ARN. */
  core: Core;
  io: AppIO;
};
