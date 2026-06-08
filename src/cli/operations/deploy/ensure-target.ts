import type { ConfigIO } from '../../../lib';
import { detectAwsContext } from '../../aws';

/**
 * Ensure `aws-targets.json` has at least one deployment target.
 *
 * Freshly-created projects (via `agentcore create`, interactive or not) write an
 * empty `aws-targets.json` by design — the target is expected to be populated at
 * deploy time. The interactive deploy flow prompts the user for it, but the
 * non-interactive deploy path (`deploy --yes` / `--json` / `--target`) has no
 * prompt, so it would otherwise fail with `Target "default" not found`.
 *
 * This mirrors the auto-populate behavior already used by `agentcore dev`
 * (`runCliDeploy`): if no targets exist, detect the account/region from the
 * environment and write a single `default` target. Best-effort — if the account
 * can't be detected, the file is left as-is and the caller surfaces a clear
 * "target not found" error.
 *
 * @returns true if a default target was written, false otherwise.
 */
export async function ensureDefaultDeploymentTarget(configIO: ConfigIO): Promise<boolean> {
  let targets;
  try {
    targets = await configIO.readAWSDeploymentTargets();
  } catch {
    // aws-targets.json missing or unreadable — treat as empty and try to populate.
    targets = [];
  }

  if (targets.length > 0) {
    return false;
  }

  const ctx = await detectAwsContext();
  if (!ctx.accountId) {
    return false;
  }

  await configIO.writeAWSDeploymentTargets([{ name: 'default', account: ctx.accountId, region: ctx.region }]);
  return true;
}
