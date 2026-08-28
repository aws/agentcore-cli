import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWrite, type ReadWriteJson } from "../../../../io";

/**
 * Project-relative path of the state file the synthesized CDK app reads.
 *
 * Under `agentcore/.cli/` to match the released CLI's location, so a project
 * created by an older CLI keeps reading the same path after upgrading. It holds
 * a target's stack binding and its imperatively created credential ARNs; the
 * scaffolded `.gitignore` keeps this one file committed while ignoring the rest
 * of `.cli/`.
 */
export const DEPLOYED_STATE_RELATIVE_PATH = join("agentcore", ".cli", "deployed-state.json");

// Passthrough like the levels above it: a stack-ARN-only update reads and
// rewrites the whole file, so stripping unknown keys here would drop fields a
// newer CLI (or the CDK app) records inside a credential entry.
const CredentialStateSchema = z
  .object({
    credentialProviderArn: z.string(),
    clientSecretArn: z.string().optional(),
  })
  .passthrough();

// Only the branches this CLI owns are modelled. Every other key the CDK app or
// the published @aws/agentcore-cdk DeployedStateSchema records under a target —
// runtimes, memories, and the rest — passes through untouched so a merge never
// drops state this code does not own.
const ResourceStateSchema = z
  .object({
    credentials: z.record(z.string(), CredentialStateSchema).optional(),
  })
  .passthrough();

const TargetStateSchema = z
  .object({
    // The deployed CloudFormation stack's ARN, captured after a successful
    // deploy. It embeds account + region + a unique id, so it both binds the
    // target to an exact deployment and lets us detect a delete-and-recreate.
    stackArn: z.string().optional(),
    resources: ResourceStateSchema.optional(),
  })
  .passthrough();

export const DeployedStateSchema = z
  .object({
    targets: z.record(z.string(), TargetStateSchema).default({}),
  })
  .passthrough();

export type DeployedState = z.infer<typeof DeployedStateSchema>;
export type TargetState = z.infer<typeof TargetStateSchema>;

function statePathFor(projectRoot: string): string {
  return join(projectRoot, DEPLOYED_STATE_RELATIVE_PATH);
}

/**
 * Reads the deployed state for a project, returning an empty state when the
 * file does not exist yet (the common case before the first deploy). Callers
 * get a fully-shaped object either way, so they never special-case absence.
 */
export async function readDeployedState(
  json: ReadWriteJson,
  projectRoot: string,
): Promise<DeployedState> {
  const statePath = statePathFor(projectRoot);
  if (!existsSync(statePath)) return { targets: {} };
  return json.read(statePath, DeployedStateSchema);
}

/**
 * Merges a patch into a single target's entry and writes the whole file back,
 * preserving every other target and every resource kind this code does not own.
 *
 * The merge is shallow except for `resources`, which is merged one level deep so
 * updating one resource kind (e.g. `credentials`) leaves the others in place.
 * A resource map provided in the patch replaces the previous map for that kind
 * wholesale, so a credential dropped from the spec stops being advertised.
 *
 * This read-modify-write is safe for sequential updates (one deploy at a time),
 * which is the only supported case — concurrent deploys of the same project can
 * still lose an update, since each reads the file before the other writes.
 */
export async function updateTargetState(
  json: ReadWriteJson,
  projectRoot: string,
  targetName: string,
  patch: Partial<TargetState>,
): Promise<DeployedState> {
  const statePath = statePathFor(projectRoot);
  const state = await readDeployedState(json, projectRoot);
  const previous = state.targets[targetName] ?? {};

  const resources =
    previous.resources || patch.resources
      ? { ...previous.resources, ...patch.resources }
      : undefined;

  const merged: TargetState = {
    ...previous,
    ...patch,
    ...(resources && { resources }),
  };

  const next: DeployedState = {
    ...state,
    targets: { ...state.targets, [targetName]: merged },
  };

  // Written atomically (temp file + rename) so an interruption or disk failure
  // can't leave a half-written, unparseable state file that blocks later deploys.
  await mkdir(dirname(statePath), { recursive: true });
  await atomicWrite(statePath, JSON.stringify(next, undefined, 2));
  return next;
}

/** Removes a target's state after its CloudFormation stack is destroyed. */
export async function removeTargetState(
  json: ReadWriteJson,
  projectRoot: string,
  targetName: string,
): Promise<DeployedState> {
  const statePath = statePathFor(projectRoot);
  const state = await readDeployedState(json, projectRoot);
  if (!(targetName in state.targets)) return state;

  const { [targetName]: _removed, ...targets } = state.targets;
  const next = { ...state, targets };
  await atomicWrite(statePath, JSON.stringify(next, undefined, 2));
  return next;
}
