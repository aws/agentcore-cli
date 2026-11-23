/**
 * The record of the targets that build writes for each Box gateway, by the gateway's name. Build
 * owns those targets, and no other. `agentcore create` and `agentcore add runtime` write an empty
 * entry for each new Box gateway, so the `egress-` rule applies only to a gateway an older CLI made.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Puts the record back as it was before a change: its old text, or no file. */
export type RestoreRecord = () => void;

/** How the record file is written and removed. */
export interface RecordFiles {
  readonly write: (path: string, text: string) => void;
  readonly remove: (path: string) => void;
}

/** The record file on disk. */
export const FS_RECORD_FILES: RecordFiles = {
  write: (path, text) => writeFileSync(path, text),
  remove: (path) => rmSync(path, { force: true }),
};

/**
 * Adds an empty entry for each of `gateways` that the record does not name yet. Returns the
 * function that puts the record back, when it wrote the record; it leaves a file that is not the
 * record to build, which refuses it.
 */
export function addBoxGatewaysToRecord(
  projectRoot: string,
  gateways: readonly string[],
  files: RecordFiles = FS_RECORD_FILES,
): RestoreRecord | undefined {
  return changeRecord(projectRoot, files, (record) => {
    const added = gateways.filter((gateway) => !Object.hasOwn(record ?? {}, gateway));
    if (added.length === 0) return undefined;
    return { ...record, ...Object.fromEntries(added.map((gateway) => [gateway, []])) };
  });
}

/**
 * Removes the entry of each of `gateways` from the record, when the record names it. Returns the
 * function that puts the record back, when it wrote the record; it leaves a file that is not the
 * record to build, which refuses it.
 */
export function removeBoxGatewaysFromRecord(
  projectRoot: string,
  gateways: readonly string[],
  files: RecordFiles = FS_RECORD_FILES,
): RestoreRecord | undefined {
  return changeRecord(projectRoot, files, (record) => {
    if (!record || !gateways.some((gateway) => Object.hasOwn(record, gateway))) return undefined;
    return Object.fromEntries(
      Object.entries(record).filter(([gateway]) => !gateways.includes(gateway)),
    );
  });
}

/**
 * Writes `text` as the record, which build computes from the gateway targets it writes. Returns the
 * function that puts the old text back, or removes the file, when the text changed.
 */
export function replaceRecord(
  projectRoot: string,
  text: string,
  files: RecordFiles = FS_RECORD_FILES,
): RestoreRecord | undefined {
  const path = join(projectRoot, ...BOX_GATEWAY_TARGETS_FILE.split("/"));
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before === text) return undefined;
  files.write(path, text);
  return () => {
    if (before === undefined) files.remove(path);
    else files.write(path, before);
  };
}

/**
 * Writes the record that `change` makes of the record, or of no record; `undefined` from `change`
 * writes nothing. Returns the function that puts the old text back, or removes the file.
 */
function changeRecord(
  projectRoot: string,
  files: RecordFiles,
  change: (record: Record<string, string[]> | undefined) => Record<string, string[]> | undefined,
): RestoreRecord | undefined {
  let record: Record<string, string[]> | undefined;
  try {
    record = readBoxGatewayTargets(projectRoot);
  } catch (error) {
    if (error instanceof ProjectStateError) return undefined;
    throw error;
  }
  const changed = change(record);
  if (changed === undefined) return undefined;
  const path = join(projectRoot, ...BOX_GATEWAY_TARGETS_FILE.split("/"));
  const before = record === undefined ? undefined : readFileSync(path, "utf8");
  files.write(path, boxGatewayTargetsText(changed));
  return () => {
    if (before === undefined) files.remove(path);
    else files.write(path, before);
  };
}
