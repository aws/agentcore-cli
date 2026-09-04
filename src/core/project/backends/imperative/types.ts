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

/** A file on disk the store uploads by streaming, never by reading it whole. */
export type LocalObjectSource = {
  absolutePath: string;
  size: number;
  /** Hex MD5 of the content, sent as the integrity check and compared with the ETag. */
  md5: string;
};

/**
 * The bucket operations a skills sync needs, declared by the backend and
 * implemented over S3 in src/core/skillsStore.ts. Every call names its region:
 * the bucket lives in the target's region, and buckets are not global.
 */
export interface SkillsStore {
  /** Whether the bucket exists and is owned by this account: "present" | "absent" | "forbidden". */
  bucketState(bucket: string, region: string): Promise<"present" | "absent" | "forbidden">;
  /** Creates the bucket in `region` (idempotent: BucketAlreadyOwnedByYou is success) and blocks public access. */
  createBucket(bucket: string, region: string): Promise<void>;
  /** Every object under `prefix` with its ETag (the MD5 for single-part uploads). */
  list(bucket: string, prefix: string, region: string): Promise<{ key: string; etag: string }[]>;
  put(bucket: string, key: string, body: LocalObjectSource, region: string): Promise<void>;
  delete(bucket: string, keys: string[], region: string): Promise<void>;
}
