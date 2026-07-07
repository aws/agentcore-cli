import type { ConfigIO } from '../../../lib';

/**
 * One-shot heads-up shown before the CFN apply when a harness uses managed memory.
 * Managed-memory harnesses provision a dedicated AgentCore Memory resource during deploy,
 * which is the slow part — surface this while it happens so the wait is explained.
 *
 * Single source of truth for both deploy entry points (CLI command + TUI flow) so the
 * wording can't drift between them.
 */
export const MANAGED_MEMORY_DEPLOY_NOTICE =
  'Managed memory: this harness provisions a dedicated AgentCore Memory resource on deploy ' +
  '(you requested --memory-mode managed).\n\n' +
  'Memory provisioning can take 3-5 minutes. We know this is slow, and we will be reducing this ' +
  'provisioning time. To skip it, redeploy with --memory-mode disabled.';

/**
 * Same heads-up worded for `add harness`, where the provisioning hasn't happened yet — it explains
 * what the next deploy will do and how to opt out before deploying.
 */
export const MANAGED_MEMORY_ADD_NOTICE =
  'Managed memory: this harness will provision a dedicated AgentCore Memory resource on deploy ' +
  '(you requested --memory-mode managed).\n\n' +
  'Memory provisioning can take 3-5 minutes. We know this is slow, and we will be reducing this ' +
  'provisioning time. To skip it, recreate the harness with --memory-mode disabled.';

/**
 * Returns true when at least one harness in the project will provision a NEW managed memory on
 * deploy (the slow 3-5 min step the notice explains) — i.e. an explicit `managed` mode. Every other
 * shape skips provisioning: `disabled` and omitted both synthesize Memory: { Disabled: {} } (no
 * memory), and `existing` references a pre-existing memory.
 *
 * The memory mode lives in each harness's harness.json (not the agentcore.json pointer list), so
 * the per-harness specs are read to detect it.
 */
export async function hasManagedMemoryHarness(
  configIO: ConfigIO,
  harnesses: { name: string }[] | undefined
): Promise<boolean> {
  for (const h of harnesses ?? []) {
    const harnessSpec = await configIO.readHarnessSpec(h.name).catch(() => undefined);
    if (harnessSpec?.memory?.mode === 'managed') {
      return true;
    }
  }
  return false;
}
