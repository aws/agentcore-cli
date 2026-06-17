import type { ConfigIO } from '../../../lib';
import { isGatedFeaturesEnabled } from '../../feature-flags';

/**
 * One-shot heads-up shown before the CFN apply when a harness uses managed memory.
 * Managed-memory harnesses provision a dedicated AgentCore Memory resource during deploy,
 * which is the slow part — surface this while it happens so the wait is explained.
 *
 * Single source of truth for both deploy entry points (CLI command + TUI flow) so the
 * wording can't drift between them.
 */
export const MANAGED_MEMORY_DEPLOY_NOTICE =
  'Managed memory: this harness automatically provisions a dedicated AgentCore Memory resource ' +
  '(the default unless you set --memory-mode existing or disabled).\n\n' +
  'Memory provisioning can take 3-5 minutes. We know this is slow, and we will be reducing this ' +
  'provisioning time. To skip it, redeploy with --memory-mode disabled.';

/**
 * Same heads-up worded for `add harness`, where the provisioning hasn't happened yet — it explains
 * what the next deploy will do and how to opt out before deploying.
 */
export const MANAGED_MEMORY_ADD_NOTICE =
  'Managed memory: this harness will automatically provision a dedicated AgentCore Memory resource ' +
  'on deploy (the default unless you set --memory-mode existing or disabled).\n\n' +
  'Memory provisioning can take 3-5 minutes. We know this is slow, and we will be reducing this ' +
  'provisioning time. To skip it, recreate the harness with --memory-mode disabled.';

/**
 * Returns true when the gate is on and at least one harness in the project uses managed memory.
 * The memory mode lives in each harness's harness.json (not the agentcore.json pointer list), so
 * the per-harness specs are read to detect it.
 */
export async function hasManagedMemoryHarness(
  configIO: ConfigIO,
  harnesses: { name: string }[] | undefined
): Promise<boolean> {
  if (!isGatedFeaturesEnabled()) {
    return false;
  }
  for (const h of harnesses ?? []) {
    const harnessSpec = await configIO.readHarnessSpec(h.name).catch(() => undefined);
    if (harnessSpec?.memory?.mode === 'managed') {
      return true;
    }
  }
  return false;
}
