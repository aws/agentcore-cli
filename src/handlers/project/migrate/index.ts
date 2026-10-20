import { createInterface } from "node:readline/promises";
import z from "zod";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  ProjectStateError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { AppIO } from "../../../io";
import { withProject } from "../../../middleware/withProject";
import { createHandler, flag, ProjectKey, type Middleware } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { progressFrom, runWithProgress, type ProgressEvent } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import { renderJsonError } from "../../utils";
import type { ProjectManager } from "../types";
import {
  CDK_LIBRARY_OVERRIDE_ENV,
  DROPPED_FIELDS_WARNING,
  stackBlockerCount,
  type MigrationPlan,
  type MigrationResult,
  type ProjectMigrator,
  type StackMigrationPlan,
  type StackRefactorResult,
  type StackResource,
  type StackResourceChange,
  type RetainedStackResource,
} from "./types";

export type { MigrationPlan, ProjectMigrator } from "./types";

type MigrateProjectHandlerConfig = {
  projectManager: ProjectManager;
  migrator: ProjectMigrator;
  io: AppIO;
  /** Directory to search upwards from. Defaults to the cwd at invocation time. */
  cwd?: string;
  middlewares?: Middleware[];
};

export const ALREADY_V1_MESSAGE =
  "This project is already in the v1 format; there's nothing to migrate.";

/**
 * The migration guide for existing projects (docs CR-309021468). The final URL is
 * TBD until the guide is published; this is the expected location.
 */
export const MIGRATION_DOCS_URL =
  "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/migration-existing-project.html";

export const CONFIRM_QUESTION = "Apply these changes? (y/N) ";

/** Printed after a ready plan when nothing can confirm applying it. */
export const APPLY_HINT =
  "Nothing was changed. Run `agentcore migrate --yes` to apply these changes.";

export const MIGRATION_FAILURE_GUIDANCE =
  "Please use `agentcore feedback` or raise a GitHub issue at https://github.com/aws/agentcore-cli.";

function migrationFailureWithGuidance(error: unknown): AgentCoreCLIError {
  const cliError = AgentCoreCLIError.fromError(error);
  if (cliError instanceof SilentCLIError) return cliError;
  return new AgentCoreCLIError(`${cliError.message}\n${MIGRATION_FAILURE_GUIDANCE}`, {
    cause: cliError,
    source: cliError.source,
    name: cliError.name,
    meta: cliError.meta,
    exitCode: cliError.exitCode,
  });
}

/** The apply hint for a run that needs its other flags repeated to apply. */
export function applyHint(flags: string[] = []): string {
  if (flags.length === 0) return APPLY_HINT;
  return `Nothing was changed. Run \`agentcore migrate --yes ${flags.join(" ")}\` to apply these changes.`;
}

/**
 * `agentcore migrate`: upgrades the enclosing v0 project to v1, one flow every
 * time. It checks the project and prints the plan (what changes in the project
 * and in the selected target's stack, and whether anything would be replaced),
 * calculated afresh: planning works in a temporary copy of the project and only
 * reads from AWS, and nothing from an earlier run is reused. A plan that isn't
 * ready stops there (exit 1). A ready one is applied once confirmed: by answering
 * "Apply these changes?" on an interactive terminal, or with --yes, which skips
 * only the prompt. Without --yes, a non-interactive or --json run only prints the
 * plan.
 *
 * One deployed target is migrated automatically; with several, --target picks
 * the one to migrate, and the others stay pending. In a project with a pending
 * migration, the same command finishes it: `agentcore migrate --target <name>`
 * migrates that pending target.
 */
export const createMigrateProjectHandler = (config: MigrateProjectHandlerConfig) =>
  createHandler({
    name: "migrate",
    description:
      "migrate an AgentCore CLI v0 project to the current project format, keeping its deployed resources",
    middlewares: [
      withProject({ projectManager: config.projectManager, cwd: config.cwd }),
      ...(config.middlewares ?? []),
    ],
    flags: [
      flag(
        "target",
        "the deployment target to migrate (required when the project is deployed to several)",
        z.string().min(1).optional(),
      ),
      flag(
        "yes",
        "apply the changes without asking, when they are ready",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      const json = ctx.require(JsonKey);
      try {
        const project = ctx.require(ProjectKey);
        if (!project.legacy && !(await config.migrator.hasPendingMigration(project.rootPath))) {
          throw new ProjectStateError(ALREADY_V1_MESSAGE);
        }
        const io = config.io;
        // Progress goes to stderr, so it never mixes with the summary (or the JSON)
        // on stdout; --json keeps it to plain lines.
        const progress = { io, ...(json && { interactive: false }) };
        const stamp = reportStamp(new Date());
        const prepared = await runWithProgress(
          progressFrom((emit) => {
            emit({ type: "step", message: "Checking the project" });
            return config.migrator.prepare(project.rootPath, {
              onStep: stepTo(emit),
              ...(flags.target !== undefined && { target: flags.target }),
            });
          }),
          progress,
        );
        try {
          const { plan } = prepared;
          const notReady = () =>
            // Not being ready is about the user's project, not a CLI failure.
            new SilentCLIError("the project can't be migrated yet", { source: ERROR_SOURCE.USER });
          const planFile = await saveReport(
            config.migrator,
            project.rootPath,
            `plan-${stamp}.md`,
            planReport(plan, stamp),
          );
          const showPlan = (footer?: string) => {
            if (json) {
              ctx.require(JsonRendererKey).renderJson(plan);
              return;
            }
            const summary = planFile.path
              ? formatMigrationSummary(plan, planFile.path)
              : // Without the report the summary would point nowhere: show everything.
                `${formatMigrationPlan(plan)}\nWarning: couldn't save the full plan (${planFile.error})\n`;
            // A blank line sets the summary apart from the progress lines above it.
            io.stdout.write(`\n${summary}${footer ? `\n${footer}\n` : ""}`);
          };

          if (!plan.ready) {
            showPlan();
            throw notReady();
          }
          const canPrompt =
            !flags.yes && !json && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
          if (!flags.yes && !canPrompt) {
            return showPlan(
              applyHint([...(flags.target !== undefined ? [`--target ${flags.target}`] : [])]),
            );
          }
          // With --json the plan goes out once, with the result.
          if (!json) showPlan();
          // The question is settled here, before apply's progress UI mounts: nothing
          // may wait on input once it does.
          if (canPrompt && !(await confirm(io))) {
            io.stdout.write("\nMigration cancelled. Nothing was changed.\n");
            return;
          }

          // Without the prompt's answer line, a blank line sets apply's progress apart from the plan.
          if (flags.yes && !json) io.stderr.write("\n");
          const result = await runWithProgress(
            progressFrom((emit) =>
              prepared.apply({
                onStep: stepTo(emit),
                onWarning: (message) => emit({ type: "warning", message }),
                onOutput: (line) => emit({ type: "output", line }),
              }),
            ),
            progress,
          );
          const resultFile = await saveReport(
            config.migrator,
            project.rootPath,
            `result-${stamp}.md`,
            resultReport(result, stamp),
          );
          if (json) ctx.require(JsonRendererKey).renderJson({ plan, result });
          else {
            io.stdout.write(
              resultFile.path
                ? `\n${formatResultSummary(result, resultFile.path, plan.cdkLibraryOverride)}`
                : `\n${formatMigrationResult(result)}`,
            );
          }
          if (!succeeded(result)) {
            throw new SilentCLIError("the migration didn't complete", {
              source: ERROR_SOURCE.USER,
            });
          }
        } finally {
          await prepared.dispose();
        }
      } catch (error) {
        const cliError = migrationFailureWithGuidance(error);
        // A not-ready plan or an incomplete migration is already on stdout.
        if (json && !(cliError instanceof SilentCLIError)) renderJsonError(ctx, cliError);
        throw cliError;
      }
    },
  });

/**
 * Whether the run did what it set out to: migrated everything, migrated the
 * selected target with others left pending, or undid an interrupted migration.
 */
function succeeded(result: MigrationResult): boolean {
  if (result.migrated || result.undone) return true;
  return (
    result.error === undefined &&
    result.restored !== true &&
    result.stacks.every((stack) => ["refactored", "unchanged"].includes(stack.outcome))
  );
}

/** Reports the migrator's step messages as progress steps. */
function stepTo(emit: (event: ProgressEvent) => void): (message: string) => void {
  return (message) => emit({ type: "step", message });
}

/** A UTC timestamp for report file names: 20261013T223000Z. */
export function reportStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Saves a report, reporting a failure instead of throwing: a report is never worth failing for. */
async function saveReport(
  migrator: ProjectMigrator,
  rootPath: string,
  fileName: string,
  contents: string,
): Promise<{ path?: string; error?: string }> {
  try {
    return { path: await migrator.saveReport(rootPath, fileName, contents) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function report(title: string, stamp: string, body: string): string {
  return `# ${title}\n\nWritten by \`agentcore migrate\` at ${stamp}.\n\n\`\`\`text\n${body}\`\`\`\n`;
}

/** The full plan, for the report file. */
export function planReport(plan: MigrationPlan, stamp: string): string {
  return report("agentcore migrate: plan", stamp, formatMigrationPlan(plan));
}

/** The full result, for the report file. */
export function resultReport(result: MigrationResult, stamp: string): string {
  return report("agentcore migrate: result", stamp, formatMigrationResult(result));
}

const SUMMARY_TEXT_LIMIT = 160;

/** The first line and sentence of a message, cut at a word near the limit. */
function brief(message: string): string {
  const firstLine = message.split("\n")[0]!.trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
  if (sentence.length <= SUMMARY_TEXT_LIMIT) return sentence;
  const cut = sentence.slice(0, SUMMARY_TEXT_LIMIT);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 0) || SUMMARY_TEXT_LIMIT)}…`;
}

/** `AWS::BedrockAgentCore::Memory` → `Memory`. */
function shortType(type: string): string {
  return type.split("::").at(-1) ?? type;
}

function listed(items: string[], limit = 5): string {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")}, and ${items.length - limit} more`;
}

/**
 * The command that installs the CDK library a plan was made with, run from the
 * project root (so `agentcore deploy` follows without changing directory): the
 * migrated app vends the released library, which a plan made with
 * AGENTCORE_MIGRATE_CDK_LIBRARY doesn't match.
 */
export function overrideInstallCommand(cdkLibraryOverride: string): string {
  const spec = cdkLibraryOverride.startsWith("file:")
    ? cdkLibraryOverride.slice("file:".length)
    : cdkLibraryOverride;
  const quoted = /^[A-Za-z0-9@%+=:,./_-]+$/.test(spec) ? spec : `'${spec.replace(/'/g, "'\\''")}'`;
  return `npm install --prefix agentcore/cdk ${quoted} --no-save`;
}

/** The preview's note on the override: installing the library comes after migrating. */
const OVERRIDE_PREVIEW_NOTE =
  `! ${CDK_LIBRARY_OVERRIDE_ENV} is set (testing only): this plan uses that CDK library. ` +
  "After migrating, you'll be shown how to install it before `agentcore deploy`.";

/** One line per thing that keeps the plan from being ready. */
export function planBlockers(plan: MigrationPlan): string[] {
  const failed = (name: string) => plan.checks.some((check) => check.name === name && !check.ok);
  // Some failures explain others: the summary shows the cause and leaves its
  // consequences to the plan file, so the user sees what to act on.
  const libraryMissing = failed(LIBRARY_CHECK);
  const unsupported = failed(SUPPORTED_RESOURCES_CHECK);
  const lines: string[] = [];
  for (const check of plan.checks) {
    if (check.ok) continue;
    if (libraryMissing && check.name === SYNTH_CHECK) continue;
    if (check.name === SUPPORTED_RESOURCES_CHECK) {
      lines.push(
        `${check.summary ?? brief(check.message)}\n    See the full plan for how to fix it.`,
      );
      continue;
    }
    lines.push(`${check.name}: ${check.summary ?? brief(check.message)}`);
  }
  for (const problem of [...plan.problems, ...plan.deployedChanges]) {
    lines.push(`${problem.file} ${problem.path}: ${brief(problem.message)}`);
  }
  for (const skipped of plan.skippedStacks) {
    if (libraryMissing && skipped.reason.includes(SYNTH_CHECK)) continue;
    const which = skipped.target === undefined ? "" : ` (${skipped.target})`;
    lines.push(`stack plan skipped${which}: ${brief(skipped.reason)}`);
  }
  for (const stack of plan.stacks) {
    for (const blocker of stack.blockers) lines.push(`${stack.stackName}: ${brief(blocker)}`);
    for (const change of [...stack.removed, ...stack.replaced, ...stack.updated]) {
      if (change.severity !== "blocker") continue;
      // The unsupported-resources line already covers what v1 can't keep.
      if (unsupported && UNSUPPORTED_TYPES.some((type) => change.type.startsWith(type))) continue;
      lines.push(`${shortType(change.type)} ${change.logicalId}: ${brief(change.reason)}`);
    }
  }
  return lines;
}

const LIBRARY_CHECK = "cdk library";
const SYNTH_CHECK = "v1 synth";
const SUPPORTED_RESOURCES_CHECK = "supported resources";
/** Resource types the unsupported-resources check stands for in the summary. */
const UNSUPPORTED_TYPES = [
  "AWS::BedrockAgentCore::CapacityProvider",
  "AWS::BedrockAgentCore::OnlineEvaluationConfig",
];

/** What the first v1 deploy does to the stack, in one line. */
function deployImpact(stack: StackMigrationPlan): string {
  // Retained resources leave the stack but stay in the account: not deletions.
  const kept = new Set((stack.retained ?? []).map((resource) => resource.logicalId));
  const deleted = stack.removed.filter((change) => !kept.has(change.logicalId));
  const lost = [
    stack.replaced.length > 0 ? `replaces ${count(stack.replaced.length, "resource")}` : "",
    deleted.length > 0 ? `deletes ${count(deleted.length, "resource")}` : "",
  ].filter(Boolean);
  const mustKeep = [...stack.removed, ...stack.replaced].filter(
    (change) => change.severity === "blocker",
  ).length;
  const parts = [
    lost.length === 0
      ? "replaces nothing"
      : `${lost.join(", ")} (${mustKeep === 0 ? "none" : count(mustKeep, "resource")} that must be kept)`,
    stack.updated.length > 0 ? `updates ${count(stack.updated.length, "resource")} in place` : "",
    stack.added.length > 0 ? `creates ${count(stack.added.length, "resource")}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

/** The top-level names of the changed files: agentcore/cdk/… stands for the CDK app. */
function changedFileNames(plan: MigrationPlan): string[] {
  const names = plan.changes.map((change) =>
    change.path.startsWith("agentcore/cdk/") ? "agentcore/cdk/…" : change.path,
  );
  return [...new Set(names)];
}

/**
 * What `agentcore migrate` prints: the plan in a few lines (or why it isn't
 * ready), pointing to the report with the full detail.
 */
export function formatMigrationSummary(plan: MigrationPlan, planPath: string): string {
  const lines: string[] = [];
  const title = plan.projectName ?? plan.rootPath;
  const [only] = plan.stacks;
  const where =
    plan.stacks.length === 1 && only
      ? ` (target ${only.target}, ${only.account}/${only.region})`
      : plan.selectedTarget
        ? ` (target ${plan.selectedTarget})`
        : "";
  lines.push(
    plan.undoInterrupted
      ? `Undo the interrupted migration of ${title}`
      : plan.finishPending
        ? `Finish the pending migration of ${title}${where}`
        : `Migration plan: ${title} → v1${where}`,
  );

  if (!plan.ready) {
    const blockers = planBlockers(plan);
    const failed = Math.max(blockers.length, 1);
    lines.push(
      "",
      `Not ready to migrate: ${failed} ${failed === 1 ? "issue needs" : "issues need"} fixing first.`,
      ...blockers.map((blocker) => `  ✖ ${blocker}`),
      "",
      `Full plan: ${planPath}`,
    );
    return `${lines.join("\n")}\n`;
  }

  if (plan.undoInterrupted) {
    lines.push(`  Puts back ${count(plan.changes.length, "file")} from the backup`);
  } else {
    if (!plan.finishPending) {
      lines.push(
        plan.pins.length === 0
          ? "  Nothing is deployed yet, so only the project files change"
          : `  Keeps the names of ${count(plan.pins.length, "deployed resource")} ` +
              `(${listed(plan.pins.map((pin) => `${pin.resourceType} ${pin.name}`))})`,
      );
    }
    for (const stack of plan.stacks) {
      lines.push(
        `  Moves ${count(stack.moves.length, "resource")} in ${stack.stackName} to new logical IDs (stack refactor)`,
        `  First v1 deploy: ${deployImpact(stack)}`,
      );
      const retained = stack.retained ?? [];
      if (retained.length > 0) {
        lines.push(
          `  ! Keeps ${count(retained.length, "resource")} in AWS outside the stack after ` +
            `migrating, where v1 won't manage ${retained.length === 1 ? "it" : "them"}: ` +
            `${listed(retained.map(retainedLabel))}`,
        );
      }
    }
    if (!plan.finishPending && plan.changes.length > 0) {
      lines.push(
        `  Changes ${count(plan.changes.length, "file")} (${listed(changedFileNames(plan), 4)})`,
      );
    }
    if (plan.pendingTargets.length > 0) {
      lines.push(
        `  Leaves ${listed(plan.pendingTargets)} pending: deploying ${plan.pendingTargets.length === 1 ? "it" : "them"} ` +
          "is blocked until each is migrated with `agentcore migrate --target <name>`",
      );
    }
  }
  const override = plan.cdkLibraryOverride;
  for (const warning of plan.warnings) {
    if (warning.startsWith(DROPPED_FIELDS_WARNING)) continue;
    if (override !== undefined && warning.includes(CDK_LIBRARY_OVERRIDE_ENV)) continue;
    lines.push(`  ! ${brief(warning)}`);
  }
  lines.push("", `Full plan: ${planPath}`);
  if (override !== undefined) lines.push("", OVERRIDE_PREVIEW_NOTE);
  return `${lines.join("\n")}\n`;
}

/** The outcome line and what to run next: review, install a test library if one was used, deploy. */
function nextSteps(outcome: string, cdkLibraryOverride: string | undefined): string[] {
  if (cdkLibraryOverride === undefined) {
    return [`${outcome} Review the changes with \`git diff\`, then run \`agentcore deploy\`.`];
  }
  return [
    `${outcome} Review the changes with \`git diff\`. ${CDK_LIBRARY_OVERRIDE_ENV} is set ` +
      "(testing only), and the migrated app uses the released CDK library, so install the one " +
      "this plan was made with, then deploy, from the project root:",
    `  ${overrideInstallCommand(cdkLibraryOverride)}`,
    "  agentcore deploy",
  ];
}

/** What `agentcore migrate` prints after applying: a line per stack, and the next step. */
export function formatResultSummary(
  result: MigrationResult,
  resultPath: string,
  cdkLibraryOverride?: string,
): string {
  const lines: string[] = [];
  for (const stack of result.stacks) {
    const ok = stack.outcome === "refactored" || stack.outcome === "unchanged";
    lines.push(
      `${ok ? "✔" : "✖"} ${stack.stackName}: ${OUTCOME_LABELS[stack.outcome]}` +
        (stack.refactorId && !ok ? ` [${stack.refactorId}]` : ""),
    );
    if (stack.message && !ok) lines.push(`  ${stack.message}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`! ${brief(warning)}`);
  // What to do by hand stays in full: it names the refactor and the commands to run.
  if (result.recovery.length > 0) {
    lines.push("", "What to do");
    for (const step of result.recovery) lines.push(`  - ${step}`);
  }
  lines.push("");
  const pending = result.pendingTargets ?? [];
  if (result.undone) {
    lines.push("Undid the interrupted migration: the project's v0 files are back.");
  } else if (result.migrated) {
    lines.push(...nextSteps("Migrated.", cdkLibraryOverride));
  } else if (result.restored) {
    lines.push(
      "The migration didn't complete, and the project's files were put back: it's v0 again.",
    );
  } else if (succeeded(result) && pending.length > 0) {
    lines.push(
      ...nextSteps(
        `Migrated this target. ${listed(pending.map((name) => `'${name}'`))} ` +
          `${pending.length === 1 ? "is" : "are"} still pending: run \`agentcore migrate --target <name>\` ` +
          "for each.",
        cdkLibraryOverride,
      ),
    );
  } else if (result.stateFile) {
    lines.push(
      `The migration is part-way through (${result.stateFile}). Fix the cause above, then run ` +
        "`agentcore migrate` again to finish it.",
    );
  } else {
    lines.push("The migration didn't complete.");
  }
  lines.push(`Details: ${resultPath}`);
  return `${lines.join("\n")}\n`;
}

/** Asks the user to confirm applying the plan; Ctrl-C or a closed stdin cancels. */
async function confirm(io: AppIO): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const answer = await Promise.race([readline.question(`\n${CONFIRM_QUESTION}`), cancelled]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

const OUTCOME_LABELS: Record<StackRefactorResult["outcome"], string> = {
  refactored: "refactored, every physical ID unchanged",
  unchanged: "nothing to move",
  "not-started": "not started",
  failed: "failed; CloudFormation left the stack as it was",
  mismatch: "not executed: CloudFormation's actions didn't match the plan",
  "needs-repair": "needs a look (see below)",
};

/** The human-readable account of what applying the migration did. */
export function formatMigrationResult(result: MigrationResult): string {
  const lines: string[] = [];
  lines.push("Stacks");
  for (const stack of result.stacks) {
    lines.push(
      `  ${stack.stackName} (target '${stack.target}'): ${OUTCOME_LABELS[stack.outcome]}` +
        (stack.refactorId ? ` [${stack.refactorId}]` : ""),
    );
    if (stack.message && stack.outcome !== "refactored") lines.push(`    ${stack.message}`);
  }
  if (result.migrated) {
    lines.push("", "Files (uncommitted, so you can review them with `git diff`)");
    for (const change of result.files) lines.push(`  ${change.kind.padEnd(8)}  ${change.path}`);
  }
  for (const warning of result.warnings ?? []) lines.push("", `Warning: ${warning}`);
  if (result.recovery.length > 0) {
    lines.push("", "What to do");
    for (const step of result.recovery) lines.push(`  - ${step}`);
  }
  lines.push("");
  const pending = result.pendingTargets ?? [];
  if (result.undone) {
    lines.push(
      "The interrupted migration was undone: the project's v0 files are back. Run " +
        "`agentcore migrate` again to migrate it.",
    );
  } else if (result.migrated) {
    lines.push(
      "Migrated. The project is now v1; its resources kept their names, and nothing was " +
        "deployed. Next: review the changes, commit them, and run `agentcore deploy`.",
    );
  } else if (result.restored) {
    lines.push(
      "The migration didn't complete, and the project's files were put back: it's v0 again.",
    );
  } else if (succeeded(result) && pending.length > 0) {
    lines.push(
      `Migrated this target. The project files are v1, and ${pending.length === 1 ? "target" : "targets"} ` +
        `${pending.map((name) => `'${name}'`).join(", ")} ${pending.length === 1 ? "is" : "are"} still ` +
        `pending (recorded in ${result.stateFile}): deploying ${pending.length === 1 ? "it" : "them"} is ` +
        "blocked until each is migrated with `agentcore migrate --target <name>`. The migrated " +
        "target can be deployed now.",
    );
  } else if (result.stateFile) {
    lines.push(
      `The migration is part-way through: ${result.stateFile} records where it is. Fix the ` +
        "cause above, then run `agentcore migrate` again to finish it.",
    );
  } else {
    lines.push("The migration didn't complete.");
  }
  lines.push(`See ${MIGRATION_DOCS_URL} for what migrating changes and what to do after.`);
  return `${lines.join("\n")}\n`;
}

/** The human-readable plan. */
export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  const title = plan.projectName ? `project '${plan.projectName}'` : plan.rootPath;
  lines.push(
    plan.undoInterrupted
      ? `Undoing the interrupted migration of ${title} (nothing was changed yet)`
      : plan.finishPending
        ? `Finishing the pending migration of ${title} (nothing was changed yet)`
        : `Migration plan for ${title} (nothing was changed)`,
    "",
  );

  lines.push("Checks");
  const nameWidth = Math.max(...plan.checks.map((check) => check.name.length));
  for (const check of plan.checks) {
    const [first = "", ...rest] = check.message.split("\n");
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(nameWidth)}  ${first}`);
    for (const line of rest) lines.push(`        ${" ".repeat(nameWidth)}  ${line}`);
  }

  if (plan.undoInterrupted) {
    lines.push("", "Files put back from the backup");
    for (const change of plan.changes) lines.push(`  ${change.kind.padEnd(8)}  ${change.path}`);
  } else if (plan.finishPending) {
    for (const stack of plan.stacks) lines.push("", ...formatStackPlan(stack));
    if (plan.pendingTargets.length > 0) {
      lines.push("", `Still pending after this run: ${plan.pendingTargets.join(", ")}`);
    }
  } else if (plan.projectName !== undefined) {
    lines.push("", 'Names kept for deployed resources (migratedFrom: "v1" keeps v0 naming)');
    if (plan.pins.length === 0) {
      lines.push("  none (nothing is deployed yet)");
    } else {
      lines.push(
        ...table(
          ["TYPE", "NAME", "AWS NAME", "TARGETS"],
          plan.pins.map((pin) => [pin.resourceType, pin.name, pin.value, pin.targets.join(", ")]),
        ).map((line) => `  ${line}`),
      );
    }

    lines.push("", "File changes");
    if (plan.changes.length === 0) lines.push("  none");
    for (const change of plan.changes) lines.push(`  ${change.kind.padEnd(8)}  ${change.path}`);

    for (const stack of plan.stacks) lines.push("", ...formatStackPlan(stack));
    if (plan.pendingTargets.length > 0) {
      lines.push(
        "",
        `Other deployed targets, recorded as pending: ${plan.pendingTargets.join(", ")}`,
        "  Their stacks keep the v0 logical IDs, and deploying them is blocked, until each is " +
          "migrated with `agentcore migrate --target <name>`.",
      );
    }
  }

  if (plan.skippedStacks.length > 0) {
    lines.push("");
    for (const skipped of plan.skippedStacks) {
      const which = skipped.target === undefined ? "" : ` (${skipped.target})`;
      lines.push(`Stack plans skipped${which}: ${skipped.reason}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }

  if (plan.deployedChanges.length > 0) {
    lines.push("", "Would change deployed configuration");
    for (const change of plan.deployedChanges) {
      lines.push(`  - ${change.file} ${change.path}: ${change.message}`);
    }
  }

  if (plan.problems.length > 0) {
    lines.push("", "Fix before migrating");
    for (const problem of plan.problems) {
      lines.push(`  - ${problem.file} ${problem.path}: ${problem.message}`);
    }
  }

  const failed =
    plan.checks.filter((check) => !check.ok).length +
    plan.problems.length +
    plan.deployedChanges.length +
    plan.stacks.reduce((sum, stack) => sum + stackBlockerCount(stack), 0);
  lines.push(
    "",
    plan.ready
      ? "Ready to migrate."
      : `Not ready to migrate: ${failed} ${failed === 1 ? "issue needs" : "issues need"} fixing first.`,
    `See ${MIGRATION_DOCS_URL} for what migrating changes and what to do after.`,
  );
  return `${lines.join("\n")}\n`;
}

/** A retained resource for the summary: its kind and the ID to find it by. */
function retainedLabel(resource: RetainedStackResource): string {
  return `${resource.type} ${resource.physicalId ?? resource.logicalId}`;
}

/** One stack's refactor: what moves, what stays outside the stack, then what the first v1 deploy does. */
export function formatStackPlan(stack: StackMigrationPlan): string[] {
  const lines = [
    `Stack ${stack.stackName} (target '${stack.target}', ${stack.account}/${stack.region})`,
  ];
  const indent = (rows: string[]) => rows.map((row) => `    ${row}`);

  lines.push(
    `  Stack refactor: moves ${count(stack.moves.length, "resource")} to new logical IDs; ` +
      `${count(stack.unchanged, "resource")} keep${stack.unchanged === 1 ? "s its" : " their"} logical ID${stack.unchanged === 1 ? "" : "s"}`,
  );
  if (stack.moves.length > 0) {
    lines.push(
      ...indent(
        table(
          ["TYPE", "FROM", "TO"],
          stack.moves.map((move) => [move.type, move.from, move.to]),
        ),
      ),
      "    The new IDs are the ones the v1 CDK app gives these resources (CDK derives them from the",
      "    construct path). The refactor only renames them in the stack: each resource, its name,",
      "    and its data stay as they are.",
    );
  }
  const retained = stack.retained ?? [];
  if (retained.length > 0) {
    lines.push(
      "",
      "  Kept in AWS outside the stack: set to retain before the refactor, so the first v1 " +
        "deploy leaves them, and their data, in place. v1 doesn't manage them afterwards.",
      ...indent(
        table(
          ["TYPE", "LOGICAL ID", "PHYSICAL ID"],
          retained.map((resource) => [
            resource.type,
            resource.logicalId,
            resource.physicalId ?? "-",
          ]),
        ),
      ),
      ...[
        ...new Map(
          retained.flatMap((resource) =>
            resource.guidance ? [[resource.type, resource.guidance] as const] : [],
          ),
        ),
      ].map(([type, guidance]) => `    ${type}: ${guidance}.`),
    );
  }

  // One row per change, the action first. An in-place update is expected, so it
  // carries a label only when it blocks the migration.
  lines.push("", `  First v1 deploy: ${deployImpact(stack)}`);
  const rows = (
    action: string,
    entries: (StackResource & Partial<StackResourceChange>)[],
    labelWarnings = true,
  ) => {
    for (const entry of entries) {
      const label =
        entry.severity === "blocker" || (labelWarnings && entry.severity === "warning")
          ? severityLabel(entry.severity)
          : "";
      const reason = entry.reason ? `: ${entry.reason}` : "";
      lines.push(`    ${action.padEnd(8)}  ${label}${entry.type} ${entry.logicalId}${reason}`);
    }
  };
  rows("creates", stack.added);
  rows("deletes", stack.removed);
  rows("replaces", stack.replaced);
  rows("updates", stack.updated, false);
  for (const blocker of stack.blockers) lines.push(`  BLOCKER: ${blocker}`);
  return lines;
}

function severityLabel(severity: StackResourceChange["severity"]): string {
  return severity === "blocker" ? "BLOCKER " : severity === "warning" ? "warning " : "";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ");
  return [header, ...rows].map(render);
}
