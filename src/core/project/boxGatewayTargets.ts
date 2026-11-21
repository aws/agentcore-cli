/**
 * The record of the targets that build writes for each Box gateway, by the gateway's name. Build
 * owns those targets, and no other. `agentcore create` and `agentcore add runtime` write an empty
 * entry for each new Box gateway, so the `egress-` rule applies only to a gateway an older CLI made.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../errors/errors";

/** The record's name in the `agentcore/` folder. */
export const BOX_GATEWAY_TARGETS_NAME = "box-gateway-targets.json";

/** The record's path from the project root. */
export const BOX_GATEWAY_TARGETS_FILE = `agentcore/${BOX_GATEWAY_TARGETS_NAME}`;

const BoxGatewayTargetsSchema = z.record(z.string(), z.array(z.string()));

/** The record as a file holds it. */
export function boxGatewayTargetsText(record: Readonly<Record<string, readonly string[]>>): string {
  return `${JSON.stringify(record, undefined, 2)}\n`;
}

/**
 * The targets build wrote for each Box gateway, or `undefined` when the project has no record.
 * Throws for a file that is not the record.
 */
export function readBoxGatewayTargets(projectRoot: string): Record<string, string[]> | undefined {
  const path = join(projectRoot, ...BOX_GATEWAY_TARGETS_FILE.split("/"));
  if (!existsSync(path)) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    document = undefined;
  }
  const record = BoxGatewayTargetsSchema.safeParse(document);
  if (record.success) return record.data;
  throw new ProjectStateError(
    `${BOX_GATEWAY_TARGETS_FILE} is not the record of the gateway targets that build writes: a ` +
      "JSON object with a list of target names for each Box gateway. Remove the file, and build " +
      "writes it again.",
  );
}

/**
 * Adds an empty entry for each of `gateways` that the record does not name yet. Returns whether it
 * wrote the record; it leaves a file that is not the record to build, which refuses it.
 */
export function addBoxGatewaysToRecord(projectRoot: string, gateways: readonly string[]): boolean {
  let record: Record<string, string[]>;
  try {
    record = readBoxGatewayTargets(projectRoot) ?? {};
  } catch (error) {
    if (error instanceof ProjectStateError) return false;
    throw error;
  }
  const added = gateways.filter((gateway) => !Object.hasOwn(record, gateway));
  if (added.length === 0) return false;
  for (const gateway of added) record[gateway] = [];
  const path = join(projectRoot, ...BOX_GATEWAY_TARGETS_FILE.split("/"));
  writeFileSync(path, boxGatewayTargetsText(record));
  return true;
}

/**
 * Removes the entry of each of `gateways` from the record, when the record names it. Returns
 * whether it wrote the record; it leaves a file that is not the record to build, which refuses it.
 */
export function removeBoxGatewaysFromRecord(
  projectRoot: string,
  gateways: readonly string[],
): boolean {
  let record: Record<string, string[]> | undefined;
  try {
    record = readBoxGatewayTargets(projectRoot);
  } catch (error) {
    if (error instanceof ProjectStateError) return false;
    throw error;
  }
  const named = gateways.filter(
    (gateway) => record !== undefined && Object.hasOwn(record, gateway),
  );
  if (record === undefined || named.length === 0) return false;
  for (const gateway of named) delete record[gateway];
  const path = join(projectRoot, ...BOX_GATEWAY_TARGETS_FILE.split("/"));
  writeFileSync(path, boxGatewayTargetsText(record));
  return true;
}
