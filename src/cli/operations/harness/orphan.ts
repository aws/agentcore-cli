import type { DeployedState, HarnessDeployedState } from '../../../schema';

/**
 * Harness orphan cleanup (transitional, preview→GA).
 *
 * An "orphan" is a harness recorded in deployed-state.json that was created by the old
 * imperative preview build: a real AWS::BedrockAgentCore::Harness that is NOT part of any
 * CloudFormation stack. The GA path provisions every harness via CloudFormation and stamps
 * its deployed-state record with `provisioner: 'cloudformation'`. A record WITHOUT that
 * marker can only have come from the imperative build, so the marker is a purely local
 * discriminator — orphan detection makes no AWS calls.
 *
 * CloudFormation cannot delete a resource it never created, so an orphan keeps billing and
 * blocks a same-named CFN deploy (the create would 409/rollback). The CLI never auto-deletes
 * it; detection only decides whether to warn the user and route deletion through
 * `agentcore remove harness <name>`.
 *
 * This whole module is self-terminating: once orphans are cleaned up and the project is
 * redeployed, every record carries the marker and `findOrphanHarnesses` returns nothing. It
 * is built to be deleted after the deprecation window.
 */

/** A located orphan harness, carrying the recorded identifiers needed to delete it. */
export interface OrphanHarness {
  /** Harness name (key under resources.harnesses). */
  name: string;
  /** Deployment target the record lives under. */
  targetName: string;
  /** Control-plane harness id, used for the DeleteHarness call. */
  harnessId: string;
  /** Recorded harness ARN; its region segment is authoritative for the delete. */
  harnessArn: string;
  /** Region parsed from the recorded ARN (never re-resolved by name). */
  region: string;
}

/**
 * A deployed-state harness record is an orphan when it exists but lacks the
 * `provisioner: 'cloudformation'` marker stamped by the CDK deploy path.
 */
export function isOrphanHarnessRecord(record: HarnessDeployedState | undefined): boolean {
  return !!record && record.provisioner !== 'cloudformation';
}

/**
 * Parse the region segment from a harness ARN
 * (arn:aws:bedrock-agentcore:<region>:<account>:harness/<id>). Returns undefined when the
 * ARN is malformed so callers can skip rather than issue a control-plane call to the wrong
 * (or empty) region.
 */
export function regionFromHarnessArn(harnessArn: string): string | undefined {
  const region = harnessArn.split(':')[3];
  return region && region.length > 0 ? region : undefined;
}

/**
 * Find orphan harnesses across all deployment targets in deployed-state. Reads local state
 * only — no AWS calls. When `harnessName` is given, restricts the search to that name.
 *
 * Records whose ARN has no parseable region are skipped (they can't be safely deleted), so
 * every returned orphan has the identifiers a deletion needs.
 */
export function findOrphanHarnesses(deployedState: DeployedState | undefined, harnessName?: string): OrphanHarness[] {
  const orphans: OrphanHarness[] = [];
  for (const [targetName, target] of Object.entries(deployedState?.targets ?? {})) {
    const harnesses = target.resources?.harnesses ?? {};
    for (const [name, record] of Object.entries(harnesses)) {
      if (harnessName && name !== harnessName) continue;
      if (!isOrphanHarnessRecord(record)) continue;
      const region = regionFromHarnessArn(record.harnessArn);
      if (!region) continue;
      orphans.push({ name, targetName, harnessId: record.harnessId, harnessArn: record.harnessArn, region });
    }
  }
  return orphans;
}
