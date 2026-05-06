/**
 * Make a deployment target's region authoritative for downstream AWS SDK calls.
 *
 * The AWS SDK (and CDK toolkit-lib's internal clients) resolve region from
 * AWS_REGION / AWS_DEFAULT_REGION when constructed without an explicit `region`
 * option. aws-targets.json is the user's source of truth for where resources
 * should be created, so we promote the target's region onto the environment for
 * the operation and restore any prior values afterwards.
 *
 * Without this override, a user with a non-default region in aws-targets.json
 * but no AWS_DEFAULT_REGION set would see resources created in the SDK's default
 * region — see https://github.com/aws/agentcore-cli/issues/924.
 *
 * --------------------------------------------------------------------------
 * Policy for new CLI entry points
 * --------------------------------------------------------------------------
 * Any new CLI command handler (anything in `src/cli/commands/*` or
 * `src/cli/operations/*` that may be invoked from a CLI / TUI entry point) that
 * could end up constructing AWS SDK clients without an explicit `region` option
 * MUST wrap its body so that `AWS_REGION` / `AWS_DEFAULT_REGION` reflect the
 * resolved deployment target's region for the duration of the call.
 *
 * Use one of:
 *   - `withTargetRegion(region, fn)`     when work fits inside a single
 *                                        callback (preferred — cannot leak).
 *   - `runWithTargetRegion(getTarget, fn)`  when target resolution and the
 *                                        work itself live in the same scope.
 *   - `applyTargetRegionToEnv(region)`   for handlers whose control flow spans
 *                                        helpers that can't easily be wrapped
 *                                        in a callback. The returned restore
 *                                        function MUST be invoked from a
 *                                        `finally` block.
 *
 * Commands that already pass `region: targetConfig.region` explicitly to every
 * SDK client they construct don't strictly need this, but adding the env
 * override is cheap and prevents regressions when new helpers are added later.
 */
import type { AwsDeploymentTarget } from '../../schema';

type RestoreEnv = () => void;

/**
 * Set AWS_REGION / AWS_DEFAULT_REGION to `region` and return a restore function.
 * Callers that cannot wrap their work in a callback (e.g. CLI entrypoints that
 * span many helpers) should use this, and invoke the returned function in a
 * `finally` block.
 */
export function applyTargetRegionToEnv(region: string): RestoreEnv {
  const prevRegion = process.env.AWS_REGION;
  const prevDefaultRegion = process.env.AWS_DEFAULT_REGION;

  process.env.AWS_REGION = region;
  process.env.AWS_DEFAULT_REGION = region;

  return () => {
    if (prevRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = prevRegion;
    }
    if (prevDefaultRegion === undefined) {
      delete process.env.AWS_DEFAULT_REGION;
    } else {
      process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
    }
  };
}

/**
 * Run `fn` with `region` applied to AWS_REGION / AWS_DEFAULT_REGION, restoring
 * the prior values on return (including when `fn` throws).
 */
export async function withTargetRegion<T>(region: string, fn: () => Promise<T>): Promise<T> {
  const restore = applyTargetRegionToEnv(region);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Resolve a deployment target via `getTarget`, apply its region to the
 * environment, and run `fn(target)` with that override in effect. Restores the
 * prior environment on return — including when target resolution itself throws,
 * when no target is found (the override is simply skipped in that case), or
 * when `fn` throws.
 *
 * Use this in command handlers where the target resolution and the AWS-SDK
 * work both live in the same lexical scope. For handlers that span many
 * helpers across `try`/`catch`/`finally` blocks, prefer the lower-level
 * `applyTargetRegionToEnv` + manual `finally` instead.
 */
export async function runWithTargetRegion<T>(
  getTarget: () => Promise<AwsDeploymentTarget | undefined>,
  fn: (target: AwsDeploymentTarget | undefined) => Promise<T>
): Promise<T> {
  const target = await getTarget();
  if (!target?.region) {
    return fn(target);
  }
  const restore = applyTargetRegionToEnv(target.region);
  try {
    return await fn(target);
  } finally {
    restore();
  }
}
