/**
 * IAM permissions boundary resolution.
 *
 * Organizations commonly attach a boundary to the CDK CloudFormation execution role that
 * denies `iam:CreateRole` unless the new role carries a boundary of its own:
 *
 * ```
 * "Condition": { "StringNotEquals": { "iam:PermissionsBoundary": "arn:aws:iam::<account>:policy/<Boundary>" } }
 * ```
 *
 * Without a way to declare that boundary, `agentcore deploy` fails while CloudFormation
 * creates the agent runtime execution role. See docs/PERMISSIONS.md.
 *
 * @module permissions-boundary
 */
import { ARN_PREFIX, CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY, PERMISSIONS_BOUNDARY_ENV_VAR } from '../constants';
import { arnPrefix } from './partition';

/**
 * Value shape aws-cdk-lib expects under {@link CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY}.
 * Exactly one of `name` / `arn` is set; `name` is expanded by the CDK against the stack's
 * own partition and account, which keeps a single config value valid across targets.
 */
export interface PermissionsBoundaryContextValue {
  name?: string;
  arn?: string;
}

export interface ResolvePermissionsBoundaryOptions {
  /** Explicit value that wins over everything else. */
  override?: string;
  /** `iam.permissionsBoundary` from the project's agentcore.json. */
  configured?: string;
  /** `permissionsBoundary` from ~/.agentcore/config.json. */
  global?: string;
  /** Process environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the permissions boundary to apply, most specific source first: explicit override,
 * `AGENTCORE_PERMISSIONS_BOUNDARY`, the project's `iam.permissionsBoundary`, then the machine's
 * global config. Returns undefined when none is configured.
 *
 * The project beats the machine because committing the value is a deliberate statement that
 * this project always deploys into a boundary-enforcing account; the global config is the
 * fallback default for every project on a developer's machine.
 *
 * A blank value counts as unset rather than falling through to the next source. That is the
 * expected reading of an empty environment variable, and it gives `agentcore config` a way to
 * clear the machine default — the command can only write values, not remove keys. Note the
 * project schema rejects a blank `iam.permissionsBoundary` instead: you are editing that file
 * by hand, so the key should simply be omitted.
 */
export function resolvePermissionsBoundary(options: ResolvePermissionsBoundaryOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const candidates = [options.override, env[PERMISSIONS_BOUNDARY_ENV_VAR], options.configured, options.global];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Whether the value is already a full IAM policy ARN rather than a bare policy name.
 * IAM policy names cannot contain `:` (`[\w+=,.@-]+`), so the prefix check is unambiguous.
 */
export function isPermissionsBoundaryArn(boundary: string): boolean {
  return boundary.trim().startsWith(ARN_PREFIX);
}

/**
 * Build the CDK context entry that makes aws-cdk-lib attach the boundary to every
 * `AWS::IAM::Role` and `AWS::IAM::User` in a stack, including roles created inside the
 * `@aws/agentcore-cdk` L3 constructs.
 */
export function permissionsBoundaryCdkContext(boundary: string): Record<string, PermissionsBoundaryContextValue> {
  const trimmed = boundary.trim();
  return {
    [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: isPermissionsBoundaryArn(trimmed) ? { arn: trimmed } : { name: trimmed },
  };
}

export interface PermissionsBoundaryArnContext {
  region: string;
  accountId: string;
}

/**
 * Expand a boundary value into a full policy ARN for direct IAM API calls, which — unlike
 * CloudFormation — cannot resolve a bare policy name. Values that are already ARNs pass through.
 */
export function toPermissionsBoundaryArn(boundary: string, context: PermissionsBoundaryArnContext): string {
  const trimmed = boundary.trim();
  if (isPermissionsBoundaryArn(trimmed)) {
    return trimmed;
  }
  return `${arnPrefix(context.region)}:iam::${context.accountId}:policy/${trimmed}`;
}
