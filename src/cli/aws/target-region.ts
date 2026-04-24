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
 */

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
