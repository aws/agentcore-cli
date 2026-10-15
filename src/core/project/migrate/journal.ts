import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import { atomicWrite } from "../../../io";

/**
 * The record of a migration in progress, relative to the project root. It's
 * written before `agentcore migrate` changes anything, and updated (atomically)
 * as each step completes, so a migration stopped at any point can be finished or
 * undone: rerunning `agentcore migrate` reads it. Deleted once the migration is
 * done.
 */
export const STATE_RELATIVE_PATH = "agentcore/.cli/migration-state.json";

const FileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "modified", "removed"]),
});

/**
 * A deployment target whose stack still has its v0 logical IDs. `pending` hasn't
 * been refactored; `retaining` had the change set that retains its unsupported
 * resources created (`changeSetName`), so a rerun plans it afresh from what the
 * stack then holds; `refactoring` had a refactor created (with `refactorId`), whose
 * outcome a rerun reads back before doing anything else.
 */
const JournalTargetSchema = z.object({
  name: z.string(),
  account: z.string(),
  region: z.string(),
  stackName: z.string(),
  status: z.enum(["pending", "retaining", "refactoring"]),
  /** The change set that retains the target's unsupported resources, recorded while `retaining`. */
  changeSetName: z.string().optional(),
  refactorId: z.string().optional(),
  /** The refactor's logical ID renames (deployed → v1), recorded with `refactorId`. */
  renames: z.array(z.tuple([z.string(), z.string()])).optional(),
});

export const MigrationStateSchema = z.object({
  version: z.literal(2),
  startedAt: z.string(),
  /**
   * The project files the migration converts: `writing` until every file is in
   * place (the originals are in the backup until then), `written` once they are,
   * `installed` once the v1 CDK app's dependencies are installed. Absent once a
   * migration no longer converts files.
   */
  files: z
    .object({
      status: z.enum(["writing", "written", "installed"]),
      /** Where the replaced v0 files are kept, relative to the project root. */
      backup: z.string(),
      changes: z.array(FileChangeSchema),
    })
    .optional(),
  /** Targets this migration has refactored; once any has, the v0 files can't come back. */
  refactored: z.array(z.string()),
  targets: z.array(JournalTargetSchema),
});

export type MigrationState = z.infer<typeof MigrationStateSchema>;
export type JournalTarget = z.infer<typeof JournalTargetSchema>;

/** Reads the record of a migration in progress; undefined when there is none. */
export async function readMigrationState(rootPath: string): Promise<MigrationState | undefined> {
  let text: string;
  try {
    text = await readFile(join(rootPath, STATE_RELATIVE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return MigrationStateSchema.parse(JSON.parse(text));
}

/** Writes the record atomically (temporary file, then rename), so it's never half-written. */
export async function writeMigrationState(rootPath: string, state: MigrationState): Promise<void> {
  const path = join(rootPath, STATE_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeMigrationState(rootPath: string): Promise<void> {
  await rm(join(rootPath, STATE_RELATIVE_PATH), { force: true });
}

/**
 * Refuses to deploy a target a migration hasn't finished with: its stack still
 * has the v0 logical IDs, so deploying the v1 project to it would replace its
 * resources. A migration stopped while writing the project files blocks every
 * target, since the files are part v0 and part v1. Other targets deploy as usual.
 */
export async function assertNoPendingMigration(rootPath: string, target?: string): Promise<void> {
  let state: MigrationState | undefined;
  try {
    state = await readMigrationState(rootPath);
  } catch (error) {
    throw new ProjectStateError(
      `Couldn't read ${STATE_RELATIVE_PATH}, the record of a migration in progress ` +
        `(${(error as Error).message}), so deploying could replace this project's resources. ` +
        "Run `agentcore migrate` to finish the migration.",
      { cause: error },
    );
  }
  if (!state) return;
  if (state.files?.status === "writing") {
    throw new ProjectStateError(
      "A migration of this project stopped while writing the project files, so they are part " +
        "v0 and part v1. Run `agentcore migrate` to put them back before you deploy.",
      { meta: { reason: "migration-interrupted" } },
    );
  }
  // Without a target (build), only half-written project files stop the command.
  if (target === undefined) return;
  const pending = state.targets.find((entry) => entry.name === target);
  if (!pending) return;
  throw new ProjectStateError(
    `Target '${pending.name}' (AWS account ${pending.account}, ${pending.region}) hasn't been ` +
      `migrated yet: its stack ${pending.stackName} still has the v0 logical IDs, so a v1 deploy ` +
      "would replace its resources. Run `agentcore migrate --target " +
      `${pending.name}\` with credentials for account ${pending.account}, then deploy.`,
    { meta: { reason: "migration-pending", target: pending.name } },
  );
}
