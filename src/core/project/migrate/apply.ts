import { join } from "node:path";
import {
  ListStackResourcesCommand,
  type CloudFormationClient,
  type StackResourceSummary,
} from "@aws-sdk/client-cloudformation";
import type {
  FileChange,
  MigrationApplyOptions,
  MigrationResult,
  StackRefactorResult,
} from "../../../handlers/project/migrate/types";
import type { ProcessRunner } from "../../../io";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import {
  BACKUP_RELATIVE_PATH,
  discardBackup,
  restoreFromBackup,
  writeMigratedFiles,
  type ProjectFilesBackup,
} from "./files";
import {
  removeMigrationState,
  STATE_RELATIVE_PATH,
  writeMigrationState,
  type JournalTarget,
  type MigrationState,
} from "./journal";
import {
  createRefactor,
  executeRefactor,
  needsManualRepair,
  StackRefactorError,
  type PollOptions,
  type RefactorAction,
} from "./refactor";
import { deleteRetainChangeSet, retainCheckCommands, retainResources } from "./retain";
import type { CfnTemplate } from "./templates";
import type { TemplateStore } from "./templateStore";

/**
 * Applying records each step in the journal before taking it, so a migration
 * stopped at any point (a crash, Ctrl-C, a failed refactor) can be finished or
 * undone, and deploying can refuse a target that's only half migrated.
 */
/** The one deployment target whose stack this run refactors. */
export type ApplyTarget = {
  target: AwsDeploymentTarget;
  stackName: string;
  /** Logical ID renames, deployed ID → v1 ID; empty when nothing in the stack moves. */
  renames: ReadonlyMap<string, string>;
  /** The deployed template with the renames applied; absent when nothing moves. */
  bridge?: CfnTemplate;
  /**
   * The update made before the refactor: the deployed template with retain
   * policies on the unsupported resources the migration keeps.
   */
  retain?: { template: CfnTemplate; logicalIds: ReadonlySet<string> };
  /** A CloudFormation client for the target's account and region. */
  client: CloudFormationClient;
  /** Where a template too big to pass inline is uploaded. */
  templates: () => Promise<TemplateStore>;
};

export type ApplierConfig = {
  rootPath: string;
  /**
   * The migration's record as this run starts: a new one when the migration starts
   * here (written before anything else changes), or the pending one being finished.
   */
  state: MigrationState;
  /**
   * The converted files to write first: the workspace they're copied from and the
   * writer of v1's vended CDK app. Absent when finishing a migration whose files are
   * already written.
   */
  files?: {
    workspaceDirectory: string;
    writeCdkApp: (cdkDirectory: string) => Promise<void>;
  };
  /** The target whose stack is refactored now; absent when none is. */
  target?: ApplyTarget;
  /** Targets whose earlier refactor is now known to have completed; they leave the record. */
  completed?: string[];
  /** Runs `npm install` in the project's v1 CDK app. */
  runner: ProcessRunner;
  poll?: PollOptions;
  /** Writes the migrated files; injectable so tests can make writing fail. */
  writeFiles?: typeof writeMigratedFiles;
  /** Persists the record; injectable so tests can make it fail. */
  saveState?: typeof writeMigrationState;
};

const INTERRUPTED = "Stopped by Ctrl-C before this stack was refactored.";

/**
 * Applies a ready migration, recording every step before it takes it, so a run
 * stopped anywhere can be finished or undone by running `agentcore migrate`
 * again:
 *
 * 1. The record is written first; if it can't be, nothing changes.
 * 2. The converted files are written (the originals backed up), then the v1 CDK
 *    app's dependencies are installed.
 * 3. The selected target's stack is refactored: CloudFormation's planned actions
 *    are checked against the plan first, and the physical IDs after. The record
 *    holds the refactor's ID while it runs.
 *
 * When nothing was refactored and the refactor didn't start, the files are put
 * back and the project is v0 again. Other targets stay in the record until
 * `agentcore migrate --target <name>` finishes them. A refactor whose outcome
 * isn't known stops everything, keeping the files and the record.
 */
export async function applyMigration(
  config: ApplierConfig,
  options: MigrationApplyOptions = {},
): Promise<MigrationResult> {
  const { rootPath } = config;
  const save = config.saveState ?? writeMigrationState;
  const poll = {
    ...config.poll,
    ...(options.onStep && { onStep: options.onStep }),
    ...(options.onOutput && { onOutput: options.onOutput }),
  };
  const state: MigrationState = structuredClone(config.state);
  const entry = config.target;
  const previousRetainChangeSet = entry
    ? state.targets.find((target) => target.name === entry.target.name)?.changeSetName
    : undefined;
  const results: StackRefactorResult[] = entry
    ? [
        {
          target: entry.target.name,
          stackName: entry.stackName,
          region: entry.target.region,
          outcome: entry.renames.size === 0 ? "unchanged" : "not-started",
        },
      ]
    : [];
  const result = (update: Partial<StackRefactorResult>) => {
    results[0] = { ...results[0]!, ...update };
  };

  // 1. The record comes first: nothing changes until it's safely on disk.
  for (const name of config.completed ?? []) markRefactored(state, name);
  options.onStep?.(`Recording the migration in ${STATE_RELATIVE_PATH}`);
  try {
    await save(rootPath, state);
  } catch (error) {
    return {
      migrated: false,
      stacks: results,
      files: [],
      error:
        `Couldn't record the migration's progress in ${STATE_RELATIVE_PATH} ` +
        `(${(error as Error).message}), so nothing was changed.`,
      recovery: [],
    };
  }

  const guard = guardInterrupts(options.onWarning ?? options.onStep);
  try {
    // 2. Files and dependencies.
    let backup: ProjectFilesBackup | undefined;
    const files = state.files?.changes ?? [];
    if (config.files && state.files) {
      try {
        options.onStep?.("Writing the v1 project files");
        backup = await (config.writeFiles ?? writeMigratedFiles)({
          rootPath,
          workspaceDirectory: config.files.workspaceDirectory,
          changes: files,
          writeCdkApp: config.files.writeCdkApp,
        });
        state.files.status = "written";
        await save(rootPath, state);
      } catch (error) {
        return await putBackFiles(rootPath, error as Error, backup, results, files);
      }
    }
    if (state.files?.status === "written") {
      try {
        options.onStep?.("Installing the v1 CDK app's dependencies (npm install)");
        await config.runner(["npm", "install", "--no-audit", "--no-fund"], {
          cwd: join(rootPath, "agentcore", "cdk"),
        });
        state.files.status = "installed";
        await save(rootPath, state);
      } catch (error) {
        if (state.refactored.length === 0) {
          return await putBackFiles(rootPath, error as Error, backup, results, files);
        }
        return partial(state, results, files, (error as Error).message, [
          "Install the v1 CDK app's dependencies (`npm install` in agentcore/cdk), then run " +
            "`agentcore migrate` again to finish the migration.",
        ]);
      }
    }

    // 3. The selected target's stack.
    let outcome: StackRefactorResult["outcome"] | undefined;
    if (entry && entry.renames.size === 0 && !entry.retain) {
      dropTarget(state, entry.target.name);
      outcome = "unchanged";
    } else if (entry) {
      if (guard.stop()) {
        result({ outcome: "not-started", message: INTERRUPTED });
      } else {
        const record = (status: JournalTarget["status"], extra: Partial<JournalTarget> = {}) =>
          setTarget(state, {
            name: entry.target.name,
            account: entry.target.account,
            region: entry.target.region,
            stackName: entry.stackName,
            status,
            ...extra,
          });
        try {
          if (entry.retain) {
            // Before the refactor, so the stack it moves (and the v1 deploy after it)
            // already keeps the resources v1 has no counterpart for.
            await retainResources(
              {
                stackName: entry.stackName,
                region: entry.target.region,
                template: entry.retain.template,
                logicalIds: entry.retain.logicalIds,
                client: entry.client,
                templates: entry.templates,
              },
              {
                ...poll,
                onCreated: async (changeSetName) => {
                  result({ retainChangeSet: changeSetName });
                  record("retaining", { changeSetName });
                  await save(rootPath, state);
                },
              },
            );
            record("pending");
            await save(rootPath, state);
          }
          if (entry.renames.size === 0) {
            dropTarget(state, entry.target.name);
            result({ outcome: "unchanged" });
          } else {
            await refactorTarget(entry, poll, async (refactorId) => {
              result({ refactorId });
              setTarget(state, {
                name: entry.target.name,
                account: entry.target.account,
                region: entry.target.region,
                stackName: entry.stackName,
                status: "refactoring",
                refactorId,
                renames: [...entry.renames],
              });
              await save(rootPath, state);
            });
            result({ outcome: "refactored" });
            markRefactored(state, entry.target.name);
          }
        } catch (error) {
          if (error instanceof ActionsMismatchError) {
            result({ outcome: "mismatch", message: error.message });
          } else if (needsManualRepair(error)) {
            result({ outcome: "needs-repair", message: (error as Error).message });
          } else {
            result({ outcome: "failed", message: (error as Error).message });
          }
          // A refactor known not to have run leaves the target as it was; one whose
          // outcome isn't known keeps its ID in the record, for a rerun to check.
          if (results[0]!.outcome !== "needs-repair") {
            setTarget(state, {
              name: entry.target.name,
              account: entry.target.account,
              region: entry.target.region,
              stackName: entry.stackName,
              status: "pending",
            });
          }
        }
      }
      outcome = results[0]!.outcome;
    }
    if (
      entry &&
      previousRetainChangeSet &&
      outcome !== undefined &&
      ["refactored", "unchanged"].includes(outcome)
    ) {
      await deleteRetainChangeSet(entry.client, entry.stackName, previousRetainChangeSet);
    }

    // 4. Done, undone, or recorded for later.
    const stackError = results
      .filter((stack) => stack.message !== undefined)
      .map((stack) => `${stack.stackName}: ${stack.message}`)
      .join("\n");
    const failed = outcome !== undefined && !["refactored", "unchanged"].includes(outcome);
    if (failed && outcome !== "needs-repair" && state.refactored.length === 0 && state.files) {
      // Nothing moved anywhere: put the v0 files back, so the project is as it was.
      return await putBackFiles(
        rootPath,
        new Error(stackError || INTERRUPTED),
        backup,
        results,
        files,
      );
    }
    if (state.targets.length === 0 && !failed) {
      await removeMigrationState(rootPath);
      const warnings = await discard(rootPath);
      return {
        migrated: true,
        stacks: results,
        files,
        recovery: [],
        ...(warnings.length > 0 && { warnings }),
      };
    }

    // Once a stack has its v1 logical IDs, only the v1 files match it: the backup
    // of the v0 files can't be used any more.
    const warnings = state.refactored.length > 0 ? await discard(rootPath) : [];
    try {
      await save(rootPath, state);
    } catch (error) {
      warnings.push(
        `Couldn't update ${STATE_RELATIVE_PATH} (${(error as Error).message}); it may still list ` +
          "a target this run refactored, which a rerun checks with CloudFormation.",
      );
    }
    const repair = results.filter((stack) => stack.outcome === "needs-repair");
    return {
      ...partial(state, results, files, stackError || undefined, [
        ...repair.flatMap((stack) => repairSteps(stack)),
        ...state.targets
          .filter((pending) => pending.status === "pending")
          .map(
            (pending) =>
              `Target '${pending.name}' (stack ${pending.stackName}, account ${pending.account}, ` +
              `${pending.region}) isn't migrated yet. Don't deploy it until it is: its stack ` +
              "still has the v0 logical IDs, so a v1 deploy would replace its resources. Run " +
              `\`agentcore migrate --target ${pending.name}\` with credentials for that account.`,
          ),
      ]),
      ...(warnings.length > 0 && { warnings }),
    };
  } finally {
    guard.release();
  }
}

/** A migration left part-way, its record kept for `agentcore migrate` to finish. */
function partial(
  state: MigrationState,
  stacks: StackRefactorResult[],
  files: FileChange[],
  error: string | undefined,
  recovery: string[],
): MigrationResult {
  return {
    migrated: false,
    stacks,
    files,
    stateFile: STATE_RELATIVE_PATH,
    pendingTargets: state.targets.map((pending) => pending.name),
    ...(error !== undefined && { error }),
    recovery,
  };
}

function setTarget(state: MigrationState, target: JournalTarget): void {
  const index = state.targets.findIndex((entry) => entry.name === target.name);
  if (index === -1) state.targets.push(target);
  else state.targets[index] = target;
}

function dropTarget(state: MigrationState, name: string): void {
  state.targets = state.targets.filter((entry) => entry.name !== name);
}

function markRefactored(state: MigrationState, name: string): void {
  dropTarget(state, name);
  if (!state.refactored.includes(name)) state.refactored.push(name);
}

/** CloudFormation's planned actions don't match the plan, so the refactor wasn't executed. */
export class ActionsMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionsMismatchError";
  }
}

/**
 * Creates one stack's refactor, checks CloudFormation's actions are exactly the
 * planned moves, records the refactor's ID, executes it, and checks that every
 * resource kept its physical ID.
 */
async function refactorTarget(
  entry: ApplyTarget,
  poll: PollOptions,
  onCreated: (refactorId: string) => Promise<void>,
): Promise<void> {
  if (!entry.bridge) throw new Error(`No refactor template was planned for ${entry.stackName}.`);
  const before = await physicalIds(entry.client, entry.stackName);
  poll.onStep?.(`Creating the refactor of stack ${entry.stackName}`);
  const created = await createRefactor(
    {
      target: entry.target.name,
      region: entry.target.region,
      stackName: entry.stackName,
      renames: entry.renames,
      template: entry.bridge,
      client: entry.client,
      templates: entry.templates,
    },
    poll,
  );
  const mismatch = actionsMismatch(created.actions, entry.renames);
  if (mismatch) {
    throw new ActionsMismatchError(
      `CloudFormation's refactor actions don't match the plan (${mismatch}), so the refactor ` +
        `(${created.refactorId}) wasn't executed and the stack is unchanged.`,
    );
  }
  await onCreated(created.refactorId);
  await executeRefactor(created, poll);
  const after = await physicalIds(entry.client, entry.stackName);
  const changed = physicalIdChanges(before, after, entry.renames);
  if (changed.length > 0) {
    throw new StackRefactorError(
      `The refactor of stack '${entry.stackName}' completed, but physical IDs changed: ` +
        `${changed.join("; ")}.`,
      {
        kind: "unknown",
        stackName: entry.stackName,
        region: entry.target.region,
        refactorId: created.refactorId,
      },
    );
  }
}

/** How CloudFormation's actions differ from the planned moves; undefined when they don't. */
export function actionsMismatch(
  actions: RefactorAction[],
  renames: ReadonlyMap<string, string>,
): string | undefined {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.action !== "MOVE" || action.entity !== "RESOURCE") {
      problems.push(`unexpected ${action.action} ${action.entity} ${action.from} → ${action.to}`);
      continue;
    }
    if (renames.get(action.from) !== action.to) {
      problems.push(`unplanned move ${action.from} → ${action.to}`);
      continue;
    }
    seen.add(action.from);
  }
  for (const [from, to] of renames) {
    if (!seen.has(from)) problems.push(`missing move ${from} → ${to}`);
  }
  return problems.length > 0 ? problems.join(", ") : undefined;
}

/** Physical IDs that changed: a moved resource under its new logical ID, or any other resource. */
export function physicalIdChanges(
  before: Map<string, string>,
  after: Map<string, string>,
  renames: ReadonlyMap<string, string>,
): string[] {
  const changes: string[] = [];
  for (const [logicalId, physicalId] of before) {
    const now = renames.get(logicalId) ?? logicalId;
    const current = after.get(now);
    if (current !== physicalId) {
      changes.push(`${logicalId} was ${physicalId}, ${now} is ${current ?? "missing"}`);
    }
  }
  return changes;
}

/** A stack's physical IDs by logical ID. */
export async function physicalIds(
  client: CloudFormationClient,
  stackName: string,
): Promise<Map<string, string>> {
  const resources: StackResourceSummary[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListStackResourcesCommand({ StackName: stackName, ...(token && { NextToken: token }) }),
    );
    resources.push(...(page.StackResourceSummaries ?? []));
    token = page.NextToken;
  } while (token);
  return new Map(
    resources.flatMap((resource) =>
      resource.LogicalResourceId && resource.PhysicalResourceId
        ? [[resource.LogicalResourceId, resource.PhysicalResourceId] as const]
        : [],
    ),
  );
}

/**
 * Puts the v0 files back after a failure before any stack was refactored, and
 * deletes the record: the project is exactly as it was. Uses the backup this run
 * made when there is one, and otherwise the one on disk.
 */
async function putBackFiles(
  rootPath: string,
  error: Error,
  backup: ProjectFilesBackup | undefined,
  stacks: StackRefactorResult[],
  changes?: FileChange[],
): Promise<MigrationResult> {
  try {
    if (backup) await backup.restore();
    else if (changes) await restoreFromBackup(rootPath, changes);
  } catch (restoreError) {
    return {
      migrated: false,
      stacks,
      files: [],
      restored: false,
      stateFile: STATE_RELATIVE_PATH,
      error: error.message,
      recovery: [
        `Couldn't put back all of the project's v0 files (${(restoreError as Error).message}). ` +
          `The originals are in ${BACKUP_RELATIVE_PATH}: copy agentcore/cdk back from its cdk ` +
          "directory and everything else from its files directory, or restore them from git " +
          "with `git checkout -- .` and delete the files `git status` lists as new. Then delete " +
          `${STATE_RELATIVE_PATH}.`,
      ],
    };
  }
  await removeMigrationState(rootPath);
  return { migrated: false, stacks, files: [], restored: true, error: error.message, recovery: [] };
}

/**
 * Undoes a migration stopped while writing the project files: puts the v0 files
 * back from the backup the record points to, and deletes the record.
 */
export async function undoInterruptedMigration(
  rootPath: string,
  state: MigrationState,
): Promise<MigrationResult> {
  const result = await putBackFiles(
    rootPath,
    new Error("An earlier run stopped while writing the project files."),
    undefined,
    [],
    state.files?.changes ?? [],
  );
  return result.restored ? { ...result, error: undefined, undone: true } : result;
}

async function discard(rootPath: string): Promise<string[]> {
  try {
    await discardBackup(rootPath);
    return [];
  } catch (error) {
    return [
      `Couldn't delete ${BACKUP_RELATIVE_PATH}: ${(error as Error).message}; delete it by hand.`,
    ];
  }
}

function repairSteps(entry: StackRefactorResult): string[] {
  if (entry.retainChangeSet && !entry.refactorId) {
    const [changeSet, stack] = retainCheckCommands(
      entry.stackName,
      entry.region,
      entry.retainChangeSet,
    );
    return [
      `Stack ${entry.stackName} (target '${entry.target}') needs a look before anything else is ` +
        `done to it: ${entry.message ?? "the outcome of the update that retains its unsupported resources isn't known"}. ` +
        "That update only sets retain policies; it doesn't change or replace any resource.",
      `Check it with \`${changeSet}\` and \`${stack}\`. Once the stack is UPDATE_COMPLETE (or ` +
        `UPDATE_ROLLBACK_COMPLETE), run \`agentcore migrate --target ${entry.target}\` to carry on.`,
    ];
  }
  const id = entry.refactorId ?? "<refactor ID>";
  const describe = `aws cloudformation describe-stack-refactor --stack-refactor-id ${id} --region ${entry.region}`;
  const list = `aws cloudformation list-stack-resources --stack-name ${entry.stackName} --region ${entry.region}`;
  return [
    `Stack ${entry.stackName} (target '${entry.target}') needs a look before anything else is ` +
      `done to it: ${entry.message ?? "its refactor's outcome isn't known"}. No AWS resource was ` +
      "deleted or replaced (a refactor only moves resources between logical IDs).",
    `Check the refactor (${id}) with \`${describe}\` and the stack with \`${list}\`. Don't ` +
      "deploy it until every resource is under the logical ID one CLI's template expects. " +
      `${STATE_RELATIVE_PATH} keeps the refactor's ID: once CloudFormation reports it finished, ` +
      `\`agentcore migrate --target ${entry.target}\` checks it and carries on.`,
  ];
}

/**
 * Turns Ctrl-C during apply into a request to stop: the step running finishes
 * (a refactor in progress always runs to its end), then the stack isn't refactored.
 * A second Ctrl-C exits at once.
 */
function guardInterrupts(notify: ((message: string) => void) | undefined): {
  stop: () => string | undefined;
  release: () => void;
} {
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) {
      release();
      // Nothing else is listening any more, so this exits the way Ctrl-C does.
      process.kill(process.pid, "SIGINT");
      return;
    }
    interrupted = true;
    notify?.(
      "Stopping once the current step ends; the stack won't be refactored. Press Ctrl-C " +
        `again to exit at once (${STATE_RELATIVE_PATH} records where the migration is)`,
    );
  };
  const release = () => process.off("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);
  return { stop: () => (interrupted ? INTERRUPTED : undefined), release };
}
