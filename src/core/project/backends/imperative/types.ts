// Interfaces the imperative backend consumes, declared here (by the consumer)
// and implemented in src/core/ over the real SDK clients.

import type { ExecutionPolicyOptions } from "../../../executionRole";

export type ExecutionRoleState = {
  roleArn: string;
  /** The inline execution policy's JSON text; undefined when the role has none. */
  policyDocument?: string;
};

/**
 * Provisions the per-harness default execution role. `describe` is the read
 * call a plan step's status check compares with the desired policy; `ensure`
 * is the idempotent write (create the role if absent, then put the policy).
 */
export interface ExecutionRoleProvisioner {
  describe(harnessName: string, region: string): Promise<ExecutionRoleState | undefined>;
  /** Returns the role's ARN. `options` shape the policy the same way they shape the desired document. */
  ensure(harnessName: string, region: string, options?: ExecutionPolicyOptions): Promise<string>;
}
