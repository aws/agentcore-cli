/**
 * Replaces the `@aws/agentcore-cdk` the migrated app synthesizes with, for
 * testing against an unreleased library build. Defined here so the command can
 * name it without importing core.
 */
export const CDK_LIBRARY_OVERRIDE_ENV = "AGENTCORE_MIGRATE_CDK_LIBRARY";

/**
 * Starts the plan warning that lists v0 fields v1 drops harmlessly: worth a line
 * in the full plan, but nothing to act on, so the summary leaves it out.
 */
export const DROPPED_FIELDS_WARNING = "Dropped fields v1 doesn't use";

/** One precondition `agentcore migrate` checks before it changes anything. */
export type MigrationCheck = {
  /** Short label, e.g. `git`. */
  name: string;
  ok: boolean;
  /** What was found, or what to do about it when the check failed. */
  message: string;
  /**
   * The one line the summary shows for a failed check, when the full message is
   * too long for it; the full message goes in the plan file.
   */
  summary?: string;
};

/**
 * Something in the project that converts to v1 only after the user changes it:
 * a field v1 validates more strictly than v0, or one v1 cannot express.
 */
export type MigrationProblem = {
  /** Project-relative file the problem is in. */
  file: string;
  /** Field path inside the file, with array entries named where they have a name. */
  path: string;
  message: string;
};

/** The resource kinds whose deployed AWS names a migrated project keeps. */
export type PinnedResourceType =
  | "runtime"
  | "runtime-repository"
  | "memory"
  | "evaluator"
  | "evaluator-function"
  | "online-eval"
  | "policy-engine"
  | "config-bundle"
  | "harness"
  | "harness-role"
  | "harness-repository"
  | "gateway"
  | "gateway-target-function"
  | "gateway-target-runtime"
  | "tool-runtime";

/**
 * A deployed resource's existing AWS name, which v1 must keep: these names are
 * create-only, so a different one replaces the resource. The migrated
 * agentcore.json sets `migratedFrom: "v1"`, which makes the CDK library compose
 * v0's names for the whole project; the plan checks that the v1 synth renders
 * each of these.
 */
export type PinnedName = {
  resourceType: PinnedResourceType;
  /** The resource's name in agentcore.json (`gateway/target` for a gateway target). */
  name: string;
  /** The AWS name. */
  value: string;
  /** The deployment targets that deployed the resource. */
  targets: string[];
};

export type FileChangeKind = "added" | "modified" | "removed";

export type FileChange = {
  /** Project-relative path, `/`-separated. */
  path: string;
  kind: FileChangeKind;
};

/** A resource in a stack, by logical ID. */
export type StackResource = {
  logicalId: string;
  type: string;
};

/** A deployed resource that a stack refactor moves to a new logical ID, keeping the AWS resource. */
export type StackResourceMove = {
  type: string;
  /** Logical ID in the deployed (v0) stack. */
  from: string;
  /** Logical ID in the v1 template. */
  to: string;
};

/**
 * How much a change the v1 deploy makes after the refactor matters: a blocker
 * stops the migration (an AgentCore resource would be lost), a warning is safe
 * but worth knowing, and info is expected housekeeping.
 */
export type StackChangeSeverity = "blocker" | "warning" | "info";

/** A deployed resource the first v1 deploy after the refactor replaces, deletes, or updates. */
export type StackResourceChange = StackResource & {
  severity: StackChangeSeverity;
  /** Why it happens and what it means. */
  reason: string;
};

/** How migrating moves one deployment target's stack onto the v1 template. */
export type StackMigrationPlan = {
  target: string;
  account: string;
  region: string;
  stackName: string;
  /** Deployed resources that move to a new logical ID. */
  moves: StackResourceMove[];
  /** How many deployed resources keep their logical ID. */
  unchanged: number;
  /** Resources the first v1 deploy creates. */
  added: StackResource[];
  /** Deployed resources the first v1 deploy deletes (or, when retained, leaves in the account). */
  removed: StackResourceChange[];
  /** Deployed resources the first v1 deploy replaces with new physical resources. */
  replaced: StackResourceChange[];
  /**
   * AgentCore resources the first v1 deploy changes in place. A change the service
   * rejects on an existing resource (a gateway's ProtocolType) is a blocker.
   */
  updated: StackResourceChange[];
  /**
   * Deployed resources v1 has no counterpart for that the migration keeps in the
   * account outside the stack: the stack is updated to retain them before its
   * refactor, and the first v1 deploy then leaves them in place. v1 doesn't
   * manage them afterwards.
   */
  retained?: RetainedStackResource[];
  /**
   * Problems with the stack as a whole (its name, the refactor template) that stop
   * it migrating. Resource-level blockers are the removed and replaced entries
   * with severity `blocker`.
   */
  blockers: string[];
  /** No blockers of either kind: the stack can be refactored and deployed as v1 without losing a resource. */
  ready: boolean;
};

/** A deployed resource a migration keeps in the account outside the stack. */
export type RetainedStackResource = {
  logicalId: string;
  type: string;
  /** Its physical ID, when the stack's resources were read. */
  physicalId?: string;
  /** How to manage and delete it once v1 no longer does. */
  guidance?: string;
};

/** Everything that stops one stack migrating: stack-level problems and blocking resource changes. */
export function stackBlockerCount(plan: StackMigrationPlan): number {
  return (
    plan.blockers.length +
    [...plan.removed, ...plan.replaced, ...plan.updated].filter(
      (change) => change.severity === "blocker",
    ).length
  );
}

/** A deployment target whose stack wasn't planned, and why. */
export type SkippedStackPlan = {
  /** Absent when every stack plan was skipped for one reason. */
  target?: string;
  reason: string;
};

/** Everything a migration would do to a project, and whether it can. */
export type MigrationPlan = {
  rootPath: string;
  /** Absent when agentcore.json could not be read as a v0 project. */
  projectName?: string;
  checks: MigrationCheck[];
  problems: MigrationProblem[];
  /**
   * Fields v1 drops from already-deployed resources, which would change them on the
   * next deploy. They block the migration like problems do, but are listed apart.
   */
  deployedChanges: MigrationProblem[];
  /** The deployed names the migrated project keeps, which the v1 synth is checked against. */
  pins: PinnedName[];
  /** Things the migration drops or the user should know about; none block it. */
  warnings: string[];
  changes: FileChange[];
  /** One per deployment target whose deployed stack could be read, once the v1 app synthesizes. */
  stacks: StackMigrationPlan[];
  /** Deployed targets with no stack plan, and why; any entry keeps the plan from being ready. */
  skippedStacks: SkippedStackPlan[];
  /** The `@aws/agentcore-cdk` spec the plan synthesized with, when overridden for testing. */
  cdkLibraryOverride?: string;
  /**
   * Set when the plan finishes a pending migration: the project files are already
   * v1, and the stack listed is the pending target to refactor now.
   */
  finishPending?: boolean;
  /**
   * Set when an earlier run stopped while writing the project files: applying the
   * plan puts the v0 files back from the backup, and nothing else.
   */
  undoInterrupted?: boolean;
  /** The deployment target whose stack this run refactors, when one is. */
  selectedTarget?: string;
  /**
   * Deployed targets this run doesn't refactor: each is recorded as pending, and
   * `agentcore migrate --target <name>` migrates it later.
   */
  pendingTargets: string[];
  /** Every check passed, nothing needs fixing first, and no stack has a blocker. */
  ready: boolean;
};

export type MigrationPlanOptions = {
  /** Called as planning starts each slow step (reading stacks, installing, synthesizing). */
  onStep?: (message: string) => void;
  /**
   * The deployment target to migrate. Required when several targets are deployed;
   * one deployed target is picked automatically.
   */
  target?: string;
};

/** What happened to one deployment target's stack when the migration was applied. */
export type StackRefactorOutcome =
  /** Refactored to the v1 logical IDs, with every physical ID unchanged. */
  | "refactored"
  /** Nothing in the stack moves, so it needed no refactor. */
  | "unchanged"
  /** Not attempted: an earlier step failed or the migration was stopped. */
  | "not-started"
  /** The refactor failed and CloudFormation left the stack as it was. */
  | "failed"
  /** CloudFormation's refactor actions didn't match the plan, so it wasn't executed. */
  | "mismatch"
  /** The refactor couldn't roll back, or its outcome is unknown: the stack needs a person. */
  | "needs-repair";

export type StackRefactorResult = {
  target: string;
  stackName: string;
  region: string;
  outcome: StackRefactorOutcome;
  refactorId?: string;
  /** The change set that set the retain policies on the stack's unsupported resources, when one ran. */
  retainChangeSet?: string;
  /** Why it failed, for the failed outcomes. */
  message?: string;
};

/** What applying a migration did. */
export type MigrationResult = {
  /** Every target's stack is refactored and the project files are v1; next is `agentcore deploy`. */
  migrated: boolean;
  stacks: StackRefactorResult[];
  /** Project files the migration changed and left changed; empty when they were put back. */
  files: FileChange[];
  /** After a failure: whether the project files were put back (the project is v0 again). */
  restored?: boolean;
  /**
   * After a partial migration: the project-relative file that records the targets
   * still to refactor; `agentcore migrate --target <name>` finishes each.
   */
  stateFile?: string;
  /** Deployed targets still to migrate, in the record. */
  pendingTargets?: string[];
  /** An interrupted migration was undone: the v0 files are back. */
  undone?: boolean;
  /** What went wrong, when the migration didn't complete. */
  error?: string;
  /** What the user has to do by hand, if anything. */
  recovery: string[];
  warnings?: string[];
};

export type MigrationApplyOptions = {
  /** Called as each slow step starts. */
  onStep?: (message: string) => void;
  /** Called with something the user should act on while applying, such as how to stop. */
  onWarning?: (message: string) => void;
  /** Called with a line of detail for the running step, such as a stack resource event. */
  onOutput?: (line: string) => void;
};

/**
 * A planned migration, kept with its working copy (the converted project) until
 * disposed, so it can be applied exactly as planned.
 */
export interface PreparedMigration {
  plan: MigrationPlan;
  /**
   * Writes the converted files into the project and installs the v1 CDK app, then
   * refactors the selected target's stack, checking CloudFormation's actions
   * against the plan first and the physical IDs after. Every step is recorded
   * first. When no stack was refactored the files are put back; other deployed
   * targets stay recorded for `agentcore migrate --target <name>`.
   */
  apply(options?: MigrationApplyOptions): Promise<MigrationResult>;
  /** Deletes the working copy. */
  dispose(): Promise<void>;
}

/** Plans the migration of a v0 project to v1, and applies it. Implemented in src/core/project/migrate. */
export interface ProjectMigrator {
  plan(rootPath: string, options?: MigrationPlanOptions): Promise<MigrationPlan>;
  /** Plans the migration and keeps what applying it needs. */
  prepare(rootPath: string, options?: MigrationPlanOptions): Promise<PreparedMigration>;
  /** Whether a pending migration is waiting to be finished in the project. */
  hasPendingMigration(rootPath: string): Promise<boolean>;
  /**
   * Writes a report (the full plan, or what applying it did) for the user to read
   * under agentcore/.cli/migrate/, and returns its project-relative path with
   * forward slashes. Migrate never reads these back.
   */
  saveReport(rootPath: string, fileName: string, contents: string): Promise<string>;
}
