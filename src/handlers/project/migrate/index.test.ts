import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRootHandler } from "../../index";
import { ProjectStateError, SilentCLIError } from "../../../errors";
import {
  CDK_LIBRARY_OVERRIDE_ENV,
  FsProjectMigrator,
  REPORTS_RELATIVE_PATH,
} from "../../../core/project/migrate";
import {
  commitAll,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeSynth,
  templateFixture,
  vendedAssets,
  writeV0Project,
} from "../../../core/project/migrate/migrate-test-support";
import {
  createSilentLogger,
  inTempDirectory,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import {
  ALREADY_V1_MESSAGE,
  APPLY_HINT,
  CONFIRM_QUESTION,
  formatMigrationPlan,
  formatMigrationResult,
  formatMigrationSummary,
  formatResultSummary,
  formatStackPlan,
  MIGRATION_DOCS_URL,
  overrideInstallCommand,
  reportStamp,
} from "./index";
import type { MigrationPlan, MigrationResult, ProjectMigrator, StackMigrationPlan } from "./types";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Writes the F1 v0 project, commits it, and cds into it. */
async function inCommittedV0Project(
  options: Parameters<typeof writeV0Project>[0] = {},
): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  commitAll(root);
  process.chdir(join(root, "app"));
  return root;
}

/** A temp directory holding a project already in the v1 format. */
async function inV1Project(): Promise<string> {
  const { path, cleanup } = await inTempDirectory("agentcore-migrate-");
  cleanups.push(cleanup);
  await mkdir(join(path, "agentcore"));
  await writeFile(
    join(path, "agentcore", "agentcore.json"),
    `${JSON.stringify({ name: "orders", version: 2 })}\n`,
  );
  return path;
}

/** A temp directory with no project anywhere above it. */
async function outsideAnyProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.chdir(dir);
  return dir;
}

describe("agentcore migrate", () => {
  test("is one command on the root, with no subcommands", async () => {
    await outsideAnyProject();
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });

    await expect(root.route(["node", "agentcore", "migrate"])).rejects.toThrow(
      /No AgentCore project found/,
    );
    const migrateCommand = root.children().find((handler) => handler.name() === "migrate");
    expect(migrateCommand?.children() ?? []).toEqual([]);
  });
});

const STACK = "AgentCore-CompatA-default";

/**
 * The real root handler and migrator, so real git and the vended CDK assets are in
 * the path. Only AWS and the v1 synth are faked: F1's stack is deployed with the
 * live-tested CompatMig template, and the v1 app synthesizes its v1 template.
 */
function cli(v1 = templateFixture("pinned.v1")) {
  const io = testIO();
  const projectMigrator = new FsProjectMigrator({
    logger: createSilentLogger(),
    assetSource: vendedAssets(),
    createCloudFormationClient: fakeCloudFormation({
      [STACK]: { template: templateFixture("pinned.v0") },
    }).create,
    ...FAKE_AWS_IDENTITY,
    synthesize: fakeSynth([{ target: "default", stackName: STACK, template: v1 }]),
  });
  const root = createRootHandler(new TestCoreClient({ projectMigrator }), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return { io, run: (...args: string[]) => root.route(["node", "agentcore", "migrate", ...args]) };
}

describe("agentcore migrate, planning", () => {
  test("prints a summary, and writes the full plan to a report git ignores", async () => {
    const root = await inCommittedV0Project();
    const subject = cli();

    await subject.run();

    const out = subject.io.stdout();
    expect(out).toStartWith(
      "Migration plan: CompatA → v1 (target default, 998846730471/us-east-1)\n",
    );
    expect(out).toMatch(/\n {2}Keeps the names of \d+ deployed resources \(runtime CompatAAgent, /);
    expect(out).toContain(
      `\n  Moves 10 resources in ${STACK} to new logical IDs (stack refactor)\n`,
    );
    expect(out).toContain(
      "\n  First v1 deploy: deletes 1 resource (none that must be kept); updates 1 resource in place\n",
    );
    expect(out).toMatch(/\n {2}Changes \d+ files \(agentcore\/agentcore\.json, /);
    expect(out).toContain("\n  ! This project has credentials (compatA-key, compatA-oauth).\n");
    // The detail is in the report, not on stdout.
    expect(out).not.toContain("Checks");
    expect(out).not.toContain("  ok    git");
    expect(out).not.toContain("Dropped fields");
    expect(out).toMatch(/\nFull plan: agentcore\/\.cli\/migrate\/plan-\d{8}T\d{6}Z\.md\n/);
    expect(out).toEndWith(APPLY_HINT);

    const reports = await readdir(join(root, REPORTS_RELATIVE_PATH));
    expect(reports).toHaveLength(1);
    expect(out).toContain(`Full plan: ${REPORTS_RELATIVE_PATH}/${reports[0]}\n`);
    const plan = await readFile(join(root, REPORTS_RELATIVE_PATH, reports[0]!), "utf8");
    expect(plan).toStartWith("# agentcore migrate: plan\n");
    expect(plan).toContain("  ok    git ");
    expect(plan).toMatch(/runtime\s+CompatAAgent\s+CompatA_CompatAAgent\s+default\n/);
    expect(plan).toContain("  - Dropped fields v1 doesn't use: credentials[compatA-oauth].usage\n");
    expect(plan).toContain(`\nStack ${STACK} (target 'default', 998846730471/us-east-1)\n`);
    expect(plan).toContain(`See ${MIGRATION_DOCS_URL}`);
    // Previewing changed nothing git would report.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(
      "",
    );

    expect(subject.io.stderr()).toBe(
      `Checking the project\nReading stack ${STACK} (998846730471/us-east-1)\n` +
        `Planning the refactor of ${STACK}`,
    );
  });

  test("every run writes its own plan, and a later run still passes the git check", async () => {
    const root = await inCommittedV0Project();
    await cli().run();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const subject = cli();
    await subject.run();
    expect(subject.io.stdout()).toEndWith(APPLY_HINT);
    expect(await readdir(join(root, REPORTS_RELATIVE_PATH))).toHaveLength(2);
  });

  test("exits non-zero when the v1 deploy would replace an AgentCore resource", async () => {
    await inCommittedV0Project();
    const subject = cli(templateFixture("codezip.v1-rc3"));

    await expect(subject.run()).rejects.toBeInstanceOf(SilentCLIError);

    const out = subject.io.stdout();
    // Every blocking change counts, one line each: 5 deletions and 3 replacements.
    expect(out).toContain("\nNot ready to migrate: 8 issues need fixing first.\n");
    expect(out).toMatch(/\n {2}✖ ConfigurationBundle \w+: /);
    expect(out.match(/^ {2}✖ /gm)).toHaveLength(8);
    expect(out).toMatch(/\n\nFull plan: agentcore\/\.cli\/migrate\/plan-\S+\.md$/);
  });

  test("--json renders the plan as JSON", async () => {
    const root = await inCommittedV0Project();
    const subject = cli();

    await subject.run("--json");

    const plan = JSON.parse(subject.io.stdout()) as MigrationPlan;
    expect(plan.ready).toBe(true);
    expect(plan.rootPath).toBe(realpathSync(root));
    expect(plan.pins).toContainEqual({
      resourceType: "harness",
      name: "CompatAHarness",
      value: "CompatA_CompatAHarness",
      targets: ["default"],
    });
    expect(plan.stacks).toHaveLength(1);
    expect(plan.stacks[0]).toMatchObject({ stackName: STACK, ready: true, replaced: [] });
  });

  test("prints the plan and exits non-zero when the project can't migrate yet", async () => {
    const root = await inCommittedV0Project();
    await writeFile(join(root, "wip.txt"), "uncommitted\n");
    const subject = cli();

    await expect(subject.run()).rejects.toBeInstanceOf(SilentCLIError);

    expect(subject.io.stdout()).toContain("Not ready to migrate: 1 issue needs fixing first.\n");
    expect(subject.io.stdout()).toContain(
      "\n  ✖ git: Commit or stash your changes before migrating",
    );
    // A failed git check doesn't keep the stack from being planned: the report has it.
    const [report] = await readdir(join(root, REPORTS_RELATIVE_PATH));
    expect(await readFile(join(root, REPORTS_RELATIVE_PATH, report!), "utf8")).toContain(
      `\nStack ${STACK} (target 'default', 998846730471/us-east-1)\n`,
    );
  });

  test("--json reports the CDK library override", async () => {
    await inCommittedV0Project();
    const previous = process.env[CDK_LIBRARY_OVERRIDE_ENV];
    process.env[CDK_LIBRARY_OVERRIDE_ENV] = "/tmp/lib.tgz";
    try {
      const subject = cli();
      await subject.run("--json");
      const plan = JSON.parse(subject.io.stdout()) as MigrationPlan;
      expect(plan.cdkLibraryOverride).toBe(`file:${resolve("/tmp/lib.tgz")}`);
      expect(plan.warnings).toContainEqual(
        `Synthesized with @aws/agentcore-cdk from ${CDK_LIBRARY_OVERRIDE_ENV} (file:${resolve("/tmp/lib.tgz")}), not the library this CLI vends; the plan holds only for that library.`,
      );
    } finally {
      if (previous === undefined) delete process.env[CDK_LIBRARY_OVERRIDE_ENV];
      else process.env[CDK_LIBRARY_OVERRIDE_ENV] = previous;
    }
  });

  test("puts the CDK library override's install command on stdout", async () => {
    await inCommittedV0Project();
    const previous = process.env[CDK_LIBRARY_OVERRIDE_ENV];
    process.env[CDK_LIBRARY_OVERRIDE_ENV] = "/tmp/lib.tgz";
    try {
      const subject = cli();
      await subject.run();
      const out = subject.io.stdout();
      expect(out).toContain(`  ! ${CDK_LIBRARY_OVERRIDE_ENV} is set (testing only)`);
      expect(out).toContain(`    ${overrideInstallCommand(`file:${resolve("/tmp/lib.tgz")}`)}\n`);
      // The override's own long warnings stay in the report.
      expect(out).not.toContain("Synthesized with @aws/agentcore-cdk from");
    } finally {
      if (previous === undefined) delete process.env[CDK_LIBRARY_OVERRIDE_ENV];
      else process.env[CDK_LIBRARY_OVERRIDE_ENV] = previous;
    }
  });

  test("has no --dry-run flag: every run previews, and only --yes or a yes applies", async () => {
    await inCommittedV0Project();
    await expect(cli().run("--dry-run")).rejects.toThrow(/unknown option '--dry-run'/);
  });

  test("rejects the removed subcommands", async () => {
    await inCommittedV0Project();
    await expect(cli().run("preview")).rejects.toThrow();
    await expect(cli().run("apply")).rejects.toThrow();
  });

  test("fails outside a project", async () => {
    await outsideAnyProject();
    await expect(cli().run()).rejects.toThrow("No AgentCore project found");
  });

  test("refuses a project that is already v1", async () => {
    await inV1Project();
    await expect(cli().run()).rejects.toThrow(ALREADY_V1_MESSAGE);
  });

  test("--json writes the already-v1 error to stdout", async () => {
    await inV1Project();
    const subject = cli();
    await expect(subject.run("--json")).rejects.toThrow(ProjectStateError);
    expect(JSON.parse(subject.io.stdout())).toEqual({ error: ALREADY_V1_MESSAGE });
  });
});

/** A ready plan, for driving the confirm/apply paths with a fake migrator. */
function readyPlan(rootPath: string): MigrationPlan {
  return {
    rootPath,
    projectName: "CompatA",
    checks: [{ name: "v0 project", ok: true, message: "'CompatA' is a v0 project" }],
    problems: [],
    deployedChanges: [],
    pins: [],
    warnings: [],
    changes: [{ path: "agentcore/agentcore.json", kind: "modified" }],
    stacks: [],
    skippedStacks: [],
    pendingTargets: [],
    ready: true,
  };
}

const MIGRATED: MigrationResult = {
  migrated: true,
  stacks: [
    {
      target: "default",
      stackName: STACK,
      region: "us-east-1",
      outcome: "refactored",
      refactorId: "rf-1",
    },
  ],
  files: [{ path: "agentcore/agentcore.json", kind: "modified" }],
  recovery: [],
};

/** A migrator whose plan and apply are scripted, recording whether apply ran. */
function scriptedCli(
  options: {
    ready?: boolean;
    result?: MigrationResult;
    isTTY?: boolean;
    stdin?: string;
    plan?: Partial<MigrationPlan>;
    failReports?: boolean;
  } = {},
) {
  const io = testIO({
    ...(options.isTTY !== undefined && { isTTY: options.isTTY }),
    ...(options.stdin !== undefined && { stdin: options.stdin }),
  });
  const calls = {
    apply: 0,
    dispose: 0,
    targets: [] as Array<string | undefined>,
    reports: [] as Array<{ fileName: string; contents: string }>,
  };
  const planFor = (rootPath: string): MigrationPlan => ({
    ...readyPlan(rootPath),
    ready: options.ready ?? true,
    ...options.plan,
  });
  const projectMigrator: ProjectMigrator = {
    plan: async (rootPath) => planFor(rootPath),
    hasPendingMigration: async () => false,
    saveReport: async (_rootPath, fileName, contents) => {
      if (options.failReports) throw new Error("disk full");
      calls.reports.push({ fileName, contents });
      return `agentcore/.cli/migrate/${fileName}`;
    },
    prepare: async (rootPath, prepareOptions) => (
      calls.targets.push(prepareOptions?.target),
      prepareOptions?.onStep?.("Reading stack S"),
      {
        plan: planFor(rootPath),
        apply: async (applyOptions) => {
          calls.apply++;
          applyOptions?.onStep?.("Refactoring stack S");
          applyOptions?.onWarning?.("Press Ctrl-C again to exit");
          return options.result ?? MIGRATED;
        },
        dispose: async () => {
          calls.dispose++;
        },
      }
    ),
  };
  const root = createRootHandler(new TestCoreClient({ projectMigrator }), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return {
    io,
    calls,
    run: (...args: string[]) => root.route(["node", "agentcore", "migrate", ...args]),
  };
}

describe("agentcore migrate, applying", () => {
  test("passes --target to the plan", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli();

    await subject.run("--target", "prod");
    await subject.run();

    expect(subject.calls.targets).toEqual(["prod", undefined]);
  });

  test("migrating the selected target with others left pending exits zero and names them", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({
      result: {
        ...MIGRATED,
        migrated: false,
        stateFile: "agentcore/.cli/migration-state.json",
        pendingTargets: ["prod"],
        recovery: ["Target 'prod' isn't migrated yet."],
      },
    });

    await subject.run("--yes");

    const out = subject.io.stdout();
    expect(out).toContain(
      "Migrated this target. 'prod' is still pending: run `agentcore migrate --target <name>` for each.",
    );
  });

  test("undoing an interrupted migration exits zero", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({
      result: {
        migrated: false,
        undone: true,
        restored: true,
        stacks: [],
        files: [],
        recovery: [],
      },
    });

    await subject.run("--yes");

    expect(subject.io.stdout()).toContain("Undid the interrupted migration");
  });

  test("without a terminal or --yes, prints the plan and how to apply it", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli();

    await subject.run();

    expect(subject.calls.apply).toBe(0);
    expect(subject.io.stdout()).toEndWith(APPLY_HINT);
    expect(subject.calls.dispose).toBe(1);
  });

  test("--yes applies a ready plan without asking", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli();

    await subject.run("--yes");

    expect(subject.calls.apply).toBe(1);
    const out = subject.io.stdout();
    expect(out).not.toContain(CONFIRM_QUESTION.trim());
    expect(out).toContain(`\n✔ ${STACK}: refactored, every physical ID unchanged\n`);
    expect(out).toContain(
      "Migrated. Review the changes with `git diff`, then run `agentcore deploy`.\n",
    );
    expect(out).toMatch(/Details: agentcore\/\.cli\/migrate\/result-\d{8}T\d{6}Z\.md$/);
    // The plan and the result share the run's timestamp.
    const [planReport, result] = subject.calls.reports;
    expect(planReport?.fileName.replace("plan-", "")).toBe(result?.fileName.replace("result-", ""));
    expect(result?.contents).toContain("# agentcore migrate: result");
    // Apply's steps and warnings go through the progress lines on stderr.
    expect(subject.io.stderr()).toContain(
      "Refactoring stack S\nWarning: Press Ctrl-C again to exit",
    );
  });

  test("--yes never applies a plan that isn't ready", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ ready: false });

    await expect(subject.run("--yes")).rejects.toBeInstanceOf(SilentCLIError);
    expect(subject.calls.apply).toBe(0);
  });

  test("on a terminal, asks first and applies on yes", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ isTTY: true, stdin: "y\n" });

    await subject.run();

    expect(subject.io.stderr()).toContain(CONFIRM_QUESTION.trim());
    expect(subject.calls.apply).toBe(1);
    // On a terminal the steps render in the progress task list.
    expect(subject.io.stderr()).toContain("Checking the project");
    expect(subject.io.stderr()).toContain("Refactoring stack S");
    // The question comes after planning's progress and before apply's.
    const err = subject.io.stderr();
    expect(err.indexOf(CONFIRM_QUESTION.trim())).toBeGreaterThan(err.indexOf("Reading stack S"));
    expect(err.indexOf(CONFIRM_QUESTION.trim())).toBeLessThan(err.indexOf("Refactoring stack S"));
  });

  test("on a terminal, anything but yes cancels", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ isTTY: true, stdin: "\n" });

    await subject.run();

    expect(subject.calls.apply).toBe(0);
    expect(subject.io.stdout()).toContain("Migration cancelled. Nothing was changed.");
  });

  test("--json without --yes only renders the plan", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ isTTY: true });

    await subject.run("--json");

    expect(subject.calls.apply).toBe(0);
    expect(JSON.parse(subject.io.stdout()).ready).toBe(true);
  });

  test("--json --yes renders the plan and the result", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli();

    await subject.run("--json", "--yes");

    const out = JSON.parse(subject.io.stdout()) as { plan: MigrationPlan; result: MigrationResult };
    expect(out.plan.ready).toBe(true);
    expect(out.result.migrated).toBe(true);
  });

  test("an incomplete migration exits non-zero after reporting it", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({
      result: {
        migrated: false,
        restored: true,
        stacks: [{ ...MIGRATED.stacks[0]!, outcome: "failed", message: "rolled back" }],
        files: [],
        error: "rolled back",
        recovery: [],
      },
    });

    await expect(subject.run("--yes")).rejects.toBeInstanceOf(SilentCLIError);
    expect(subject.io.stdout()).toContain("the project's files were put back: it's v0 again");
  });
});

describe("agentcore migrate, reports", () => {
  test("after applying with the library override, installing it is the next step", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ plan: { cdkLibraryOverride: "file:/tmp/lib.tgz" } });

    await subject.run("--yes");

    const out = subject.io.stdout();
    expect(out).toContain(
      "Migrated. Review the changes with `git diff`, then:\n" +
        `  ! ${CDK_LIBRARY_OVERRIDE_ENV} is set (testing only): the migrated app uses the released\n` +
        "    library, so before `agentcore deploy` install the one this plan was made with:\n" +
        "      cd agentcore/cdk && npm install /tmp/lib.tgz --no-save\n" +
        "    agentcore deploy\n",
    );
  });

  test("an unknown refactor outcome keeps its ID and the commands to check it on stdout", async () => {
    await inCommittedV0Project();
    const check = `aws cloudformation describe-stack-refactor --stack-refactor-id rf-9 --region us-east-1`;
    const subject = scriptedCli({
      result: {
        migrated: false,
        stacks: [
          {
            ...MIGRATED.stacks[0]!,
            outcome: "needs-repair",
            refactorId: "rf-9",
            message: "Whether the refactor ran isn't known.",
          },
        ],
        files: [],
        stateFile: "agentcore/.cli/migration-state.json",
        error: "unknown",
        recovery: [`Check the refactor: ${check}`],
      },
    });

    await expect(subject.run("--yes")).rejects.toBeInstanceOf(SilentCLIError);

    const out = subject.io.stdout();
    expect(out).toContain(`✖ ${STACK}: needs a look (see below) [rf-9]\n`);
    expect(out).toContain("  Whether the refactor ran isn't known.\n");
    expect(out).toContain(`What to do\n  - Check the refactor: ${check}\n`);
  });

  test("shows the full plan when the report can't be written", async () => {
    await inCommittedV0Project();
    const subject = scriptedCli({ failReports: true });

    await subject.run();

    const out = subject.io.stdout();
    expect(out).toContain("Checks\n");
    expect(out).toContain("Warning: couldn't save the full plan (disk full)");
    expect(out).toEndWith(APPLY_HINT);
  });
});

describe("formatMigrationSummary", () => {
  const base: MigrationPlan = {
    rootPath: "/p",
    projectName: "Proj",
    checks: [{ name: "v0 project", ok: true, message: "'Proj' is a v0 project" }],
    problems: [],
    deployedChanges: [],
    pins: [
      { resourceType: "runtime", name: "agent", value: "Proj_agent", targets: ["default"] },
      { resourceType: "memory", name: "mem", value: "Proj_mem", targets: ["default"] },
    ],
    warnings: ["Dropped unassigned gateway targets (t1): v1 has no unassigned targets. More."],
    changes: [
      { path: "agentcore/agentcore.json", kind: "modified" },
      { path: "agentcore/cdk/bin/cdk.ts", kind: "modified" },
      { path: "agentcore/cdk/lib/cdk-stack.ts", kind: "modified" },
    ],
    stacks: [
      {
        target: "default",
        account: "123456789012",
        region: "us-east-1",
        stackName: "AgentCore-Proj-default",
        moves: [{ type: "AWS::BedrockAgentCore::Memory", from: "A", to: "B" }],
        unchanged: 0,
        added: [],
        removed: [],
        replaced: [],
        updated: [
          {
            logicalId: "Rt",
            type: "AWS::BedrockAgentCore::Runtime",
            severity: "warning",
            reason: "EnvironmentVariables change",
          },
        ],
        blockers: [],
        ready: true,
      },
    ],
    skippedStacks: [],
    pendingTargets: [],
    ready: true,
  };

  test("a ready plan: a few lines and the report", () => {
    expect(formatMigrationSummary(base, "agentcore/.cli/migrate/plan-1.md")).toBe(
      [
        "Migration plan: Proj → v1 (target default, 123456789012/us-east-1)",
        "  Keeps the names of 2 deployed resources (runtime agent, memory mem)",
        "  Moves 1 resource in AgentCore-Proj-default to new logical IDs (stack refactor)",
        "  First v1 deploy: replaces nothing; updates 1 resource in place",
        "  Changes 3 files (agentcore/agentcore.json, agentcore/cdk/…)",
        "  ! Dropped unassigned gateway targets (t1): v1 has no unassigned targets.",
        "",
        "Full plan: agentcore/.cli/migrate/plan-1.md",
        "",
      ].join("\n"),
    );
  });

  test("a plan that isn't ready: one line per blocker", () => {
    const stack = base.stacks[0]!;
    const out = formatMigrationSummary(
      {
        ...base,
        ready: false,
        checks: [
          ...base.checks,
          { name: "cdk app", ok: false, message: "agentcore/cdk was changed.\n  added  x.ts" },
        ],
        stacks: [
          {
            ...stack,
            ready: false,
            replaced: [
              {
                logicalId: "Mem",
                type: "AWS::BedrockAgentCore::Memory",
                severity: "blocker",
                reason: "the v1 deploy would replace it. Its data would be lost.",
              },
            ],
          },
        ],
      },
      "agentcore/.cli/migrate/plan-1.md",
    );
    expect(out).toBe(
      [
        "Migration plan: Proj → v1 (target default, 123456789012/us-east-1)",
        "",
        "Not ready to migrate: 2 issues need fixing first.",
        "  ✖ cdk app: agentcore/cdk was changed.",
        "  ✖ Memory Mem: the v1 deploy would replace it.",
        "",
        "Full plan: agentcore/.cli/migrate/plan-1.md",
        "",
      ].join("\n"),
    );
  });

  test("names the targets left pending, and titles a pending migration it finishes", () => {
    expect(formatMigrationSummary({ ...base, pendingTargets: ["prod"] }, "p.md")).toContain(
      "  Leaves prod pending: deploying it is blocked until each is migrated with " +
        "`agentcore migrate --target <name>`\n",
    );
    expect(formatMigrationSummary({ ...base, finishPending: true }, "p.md").split("\n")[0]).toBe(
      "Finish the pending migration of Proj (target default, 123456789012/us-east-1)",
    );
  });
});

describe("report helpers", () => {
  test("reportStamp is a compact UTC timestamp", () => {
    expect(reportStamp(new Date("2026-10-13T22:30:05.123Z"))).toBe("20261013T223005Z");
  });

  test("overrideInstallCommand uses a file override's path, quoting when needed", () => {
    expect(overrideInstallCommand("file:/tmp/lib.tgz")).toBe(
      "cd agentcore/cdk && npm install /tmp/lib.tgz --no-save",
    );
    expect(overrideInstallCommand("@aws/agentcore-cdk@1.0.0-rc.4")).toBe(
      "cd agentcore/cdk && npm install @aws/agentcore-cdk@1.0.0-rc.4 --no-save",
    );
    expect(overrideInstallCommand("file:/tmp/my lib.tgz")).toBe(
      "cd agentcore/cdk && npm install '/tmp/my lib.tgz' --no-save",
    );
  });

  test("formatResultSummary points at the details", () => {
    expect(formatResultSummary(MIGRATED, "r.md")).toBe(
      [
        `✔ ${STACK}: refactored, every physical ID unchanged`,
        "",
        "Migrated. Review the changes with `git diff`, then run `agentcore deploy`.",
        "Details: r.md",
        "",
      ].join("\n"),
    );
  });
});

describe("formatMigrationResult", () => {
  test("a part-way migration says how to finish it", () => {
    const out = formatMigrationResult({
      migrated: false,
      stacks: [
        { ...MIGRATED.stacks[0]!, target: "dev" },
        { ...MIGRATED.stacks[0]!, target: "prod", outcome: "failed", message: "throttled" },
      ],
      files: [],
      stateFile: "agentcore/.cli/migration-state.json",
      error: "throttled",
      recovery: ["Target 'prod' wasn't refactored."],
    });
    expect(out).toContain("failed; CloudFormation left the stack as it was");
    expect(out).toContain("  - Target 'prod' wasn't refactored.");
    expect(out).toContain(
      "agentcore/.cli/migration-state.json records where it is. Fix the cause above, then run " +
        "`agentcore migrate` again",
    );
    expect(out).toContain(MIGRATION_DOCS_URL);
  });
});

describe("formatMigrationPlan", () => {
  test("renders checks, pins, changes, warnings, and problems", () => {
    const plan: MigrationPlan = {
      rootPath: "/p",
      projectName: "Proj",
      checks: [
        { name: "v0 project", ok: true, message: "'Proj' is a v0 project" },
        { name: "git", ok: false, message: "Commit or stash these changes first:\n  ?? x" },
      ],
      deployedChanges: [
        {
          file: "agentcore/agentcore.json",
          path: "payments[pm].x",
          message: "v1 drops this field",
        },
      ],
      problems: [
        { file: "agentcore/agentcore.json", path: "credentials[ab].name", message: "too short" },
      ],
      pins: [
        {
          resourceType: "runtime",
          name: "agent",
          value: "Proj_agent",
          targets: ["default"],
        },
      ],
      warnings: ["Dropped fields v1 doesn't use: credentials[o].usage"],
      changes: [
        { path: "agentcore/agentcore.json", kind: "modified" },
        { path: "app/h/harness.yaml", kind: "added" },
      ],
      stacks: [],
      skippedStacks: [{ target: "prod", reason: "credentials for account 2 are needed" }],
      pendingTargets: [],
      ready: false,
    };
    expect(formatMigrationPlan(plan)).toBe(
      [
        "Migration plan for project 'Proj' (nothing was changed)",
        "",
        "Checks",
        "  ok    v0 project  'Proj' is a v0 project",
        "  FAIL  git         Commit or stash these changes first:",
        "                      ?? x",
        "",
        'Names kept for deployed resources (migratedFrom: "v1" keeps v0 naming)',
        "  TYPE     NAME   AWS NAME    TARGETS",
        "  runtime  agent  Proj_agent  default",
        "",
        "File changes",
        "  modified  agentcore/agentcore.json",
        "  added     app/h/harness.yaml",
        "",
        "Stack plans skipped (prod): credentials for account 2 are needed",
        "",
        "Warnings",
        "  - Dropped fields v1 doesn't use: credentials[o].usage",
        "",
        "Would change deployed configuration",
        "  - agentcore/agentcore.json payments[pm].x: v1 drops this field",
        "",
        "Fix before migrating",
        "  - agentcore/agentcore.json credentials[ab].name: too short",
        "",
        "Not ready to migrate: 3 issues need fixing first.",
        `See ${MIGRATION_DOCS_URL} for what migrating changes and what to do after.`,
        "",
      ].join("\n"),
    );
  });

  test("says when nothing is deployed and skips sections for a project it couldn't read", () => {
    const base = {
      rootPath: "/p",
      problems: [],
      deployedChanges: [],
      pins: [],
      warnings: [],
      changes: [],
      stacks: [],
      skippedStacks: [],
      pendingTargets: [],
    };
    expect(
      formatMigrationPlan({
        ...base,
        projectName: "Proj",
        checks: [{ name: "v0 project", ok: true, message: "ok" }],
        ready: true,
      }),
    ).toContain(
      'Names kept for deployed resources (migratedFrom: "v1" keeps v0 naming)\n  none (nothing is deployed yet)\n',
    );
    const unreadable = formatMigrationPlan({
      ...base,
      checks: [{ name: "v0 project", ok: false, message: "already v1" }],
      ready: false,
    });
    expect(unreadable).toStartWith("Migration plan for /p (nothing was changed)");
    expect(unreadable).not.toContain("File changes");
  });
});

describe("formatMigrationPlan, targets", () => {
  const base: MigrationPlan = {
    rootPath: "/p",
    projectName: "Proj",
    checks: [{ name: "target", ok: true, message: "migrating 'dev'" }],
    problems: [],
    deployedChanges: [],
    pins: [],
    warnings: [],
    changes: [],
    stacks: [],
    skippedStacks: [],
    pendingTargets: ["prod", "test"],
    selectedTarget: "dev",
    ready: true,
  };

  test("names the deployed targets recorded as pending", () => {
    expect(formatMigrationPlan(base)).toContain(
      "Other deployed targets, recorded as pending: prod, test\n" +
        "  Their stacks keep the v0 logical IDs, and deploying them is blocked, until each is " +
        "migrated with `agentcore migrate --target <name>`.\n",
    );
  });

  test("titles a plan that finishes a pending migration, or undoes an interrupted one", () => {
    expect(formatMigrationPlan({ ...base, finishPending: true })).toStartWith(
      "Finishing the pending migration of project 'Proj' (nothing was changed yet)\n",
    );
    const undo = formatMigrationPlan({
      ...base,
      pendingTargets: [],
      undoInterrupted: true,
      changes: [{ path: "agentcore/agentcore.json", kind: "modified" }],
    });
    expect(undo).toStartWith(
      "Undoing the interrupted migration of project 'Proj' (nothing was changed yet)\n",
    );
    expect(undo).toContain(
      "Files put back from the backup\n  modified  agentcore/agentcore.json\n",
    );
  });
});

describe("formatStackPlan", () => {
  const stack: StackMigrationPlan = {
    target: "default",
    account: "123456789012",
    region: "us-east-1",
    stackName: "AgentCore-P-default",
    moves: [{ type: "AWS::BedrockAgentCore::Memory", from: "OldMem", to: "NewMem" }],
    unchanged: 1,
    added: [{ logicalId: "Trigger2", type: "AWS::CloudFormation::CustomResource" }],
    removed: [
      {
        logicalId: "Trigger1",
        type: "AWS::CloudFormation::CustomResource",
        severity: "info",
        reason: "recreated",
      },
    ],
    replaced: [
      { logicalId: "Repo", type: "AWS::ECR::Repository", severity: "warning", reason: "rebuilt" },
      {
        logicalId: "Bundle",
        type: "AWS::BedrockAgentCore::ConfigurationBundle",
        severity: "blocker",
        reason: "lost",
      },
    ],
    updated: [
      {
        logicalId: "Gw",
        type: "AWS::BedrockAgentCore::Gateway",
        severity: "blocker",
        reason: "ProtocolType changes",
      },
    ],
    blockers: ["the stack name changes"],
    ready: false,
  };

  test("lists moves, the first v1 deploy's changes, and the verdict", () => {
    expect(formatStackPlan(stack)).toEqual([
      "Stack AgentCore-P-default (target 'default', 123456789012/us-east-1)",
      "  Refactor: move 1 resource to new logical IDs",
      "    TYPE                           FROM    TO",
      "    AWS::BedrockAgentCore::Memory  OldMem  NewMem",
      "  1 resource keep their logical IDs",
      "  Then the first v1 deploy:",
      "    creates",
      "      AWS::CloudFormation::CustomResource Trigger2",
      "    deletes",
      "      AWS::CloudFormation::CustomResource Trigger1: recreated",
      "    replaces",
      "      warning AWS::ECR::Repository Repo: rebuilt",
      "      BLOCKER AWS::BedrockAgentCore::ConfigurationBundle Bundle: lost",
      "    updates in place",
      "      BLOCKER AWS::BedrockAgentCore::Gateway Gw: ProtocolType changes",
      "  Replacements: 1 resource that must be kept would be replaced or deleted",
      "  BLOCKER: the stack name changes",
    ]);
  });

  test("says when the deploy changes nothing", () => {
    const quiet = formatStackPlan({
      ...stack,
      moves: [],
      added: [],
      removed: [],
      replaced: [],
      updated: [],
      blockers: [],
    });
    expect(quiet).toContain("  Refactor: move 0 resources to new logical IDs");
    expect(quiet).toContain("    creates, deletes, and replaces nothing");
    expect(quiet.at(-1)).toBe(
      "  Replacements: 0 replacements; no resource that must be kept is replaced or deleted",
    );
  });
});
