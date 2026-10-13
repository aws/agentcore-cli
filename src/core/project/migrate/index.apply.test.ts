import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProcess, type ProcessRunner } from "../../../io";
import { createSilentLogger } from "../../../testing";
import { FsAssetSource } from "../source";
import { BACKUP_RELATIVE_PATH } from "./files";
import {
  assertNoPendingMigration,
  readMigrationState,
  STATE_RELATIVE_PATH,
  writeMigrationState,
} from "./journal";
import { CDK_LIBRARY_OVERRIDE_ENV, FsProjectMigrator } from "./index";
import {
  commitAll,
  F1_DEPLOYED_STATE,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeSynth,
  templateFixture,
  vendedAssets,
  writeV0Project,
  type FakeCloudFormationOptions,
  type V0ProjectFiles,
} from "./migrate-test-support";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const STACK = "AgentCore-CompatA-default";
const PROD_STACK = "AgentCore-CompatA-prod";

async function committedProject(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  commitAll(root);
  return root;
}

/** Real git; npm is recorded instead of run. */
function runner(): ProcessRunner & { npm: string[][] } {
  const npm: string[][] = [];
  const run: ProcessRunner = async (args, options) => {
    if (args[0] === "npm") {
      npm.push([...args, `cwd=${options.cwd}`]);
      return;
    }
    return runProcess(args, options);
  };
  return Object.assign(run, { npm });
}

function migrator(
  options: {
    stacks?: Array<{ name: string; target: string }>;
    cloudFormation?: FakeCloudFormationOptions;
    /** Reuse another migrator's (stateful) CloudFormation, as a rerun would. */
    sharedCloudFormation?: ReturnType<typeof fakeCloudFormation>;
    vendedVersion?: string;
    env?: NodeJS.ProcessEnv;
    account?: string;
  } = {},
) {
  const stacks = options.stacks ?? [{ name: STACK, target: "default" }];
  const cloudFormation =
    options.sharedCloudFormation ??
    fakeCloudFormation(
      Object.fromEntries(
        stacks.map((stack) => [stack.name, { template: templateFixture("pinned.v0") }]),
      ),
      options.cloudFormation,
    );
  const run = runner();
  const subject = new FsProjectMigrator({
    logger: createSilentLogger(),
    runner: run,
    assetSource: vendedAssets(options.vendedVersion),
    createCloudFormationClient: cloudFormation.create,
    ...FAKE_AWS_IDENTITY,
    ...(options.account && { resolveAccount: async () => options.account! }),
    synthesize: fakeSynth(
      stacks.map((stack) => ({
        target: stack.target,
        stackName: stack.name,
        template: templateFixture("pinned.v1"),
      })),
    ),
    env: options.env ?? {},
    poll: { intervalMs: 0, sleep: async () => {} },
  });
  return { subject, cloudFormation, run };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("FsProjectMigrator: applying a migration", () => {
  test("converts the files in place and refactors the stack, keeping physical IDs", async () => {
    const root = await committedProject();
    const { subject, cloudFormation, run } = migrator();
    const resourcesBefore = Object.keys(templateFixture("pinned.v0").Resources ?? {});

    const prepared = await subject.prepare(root);
    expect(prepared.plan.ready).toBe(true);
    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.migrated).toBe(true);
    expect(result.stacks.map((stack) => stack.outcome)).toEqual(["refactored"]);

    const spec = await readJson(join(root, "agentcore", "agentcore.json"));
    expect(spec.version).toBe(2);
    expect(spec.migratedFrom).toBe("v1");
    expect(existsSync(join(root, "app", "CompatAHarness", "harness.yaml"))).toBe(true);
    // v1's vended app replaced the v0 one wholesale.
    const vendedBin = await new FsAssetSource().read("cdk/bin/cdk.ts");
    expect(await readFile(join(root, "agentcore", "cdk", "bin", "cdk.ts"), "utf8")).toBe(vendedBin);
    expect(existsSync(join(root, "agentcore", "cdk", "jest.config.js"))).toBe(false);
    expect(run.npm).toEqual([
      ["npm", "install", "--no-audit", "--no-fund", `cwd=${join(root, "agentcore", "cdk")}`],
    ]);
    expect(existsSync(join(root, BACKUP_RELATIVE_PATH))).toBe(false);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);

    // The stack now has the v1 logical IDs, with every resource still there.
    const moved = Object.keys(cloudFormation.stacks[STACK]!.template!.Resources ?? {});
    expect(moved).toHaveLength(resourcesBefore.length);
    expect(moved).not.toEqual(resourcesBefore);
    const executed = cloudFormation.calls.filter(
      (call) => call.command === "ExecuteStackRefactorCommand",
    );
    expect(executed).toHaveLength(1);
  });

  test("refuses to apply when the tree changed after planning", async () => {
    const root = await committedProject();
    const { subject, cloudFormation } = migrator();
    const prepared = await subject.prepare(root);
    await writeFile(join(root, "wip.txt"), "uncommitted\n");

    await expect(prepared.apply()).rejects.toThrow(/Uncommitted changes/);
    await prepared.dispose();

    expect((await readJson(join(root, "agentcore", "agentcore.json"))).version).toBe(1);
    expect(cloudFormation.calls.some((call) => call.command === "CreateStackRefactorCommand")).toBe(
      false,
    );
  });

  test("puts the v0 files back when the only stack's refactor is rejected", async () => {
    const root = await committedProject();
    const { subject } = migrator({
      cloudFormation: { refactors: () => ({ create: { status: "CREATE_FAILED", reason: "no" } }) },
    });

    const prepared = await subject.prepare(root);
    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.migrated).toBe(false);
    expect(result.restored).toBe(true);
    expect((await readJson(join(root, "agentcore", "agentcore.json"))).version).toBe(1);
    let status = "";
    await runProcess(["git", "status", "--porcelain"], {
      cwd: root,
      onOutput: (text) => (status += text),
    });
    expect(status.trim()).toBe("");
  });

  test("blocks when the CLI's vended CDK library doesn't keep v0 names", async () => {
    const root = await committedProject();
    const { subject } = migrator({ vendedVersion: "1.0.0-rc.3" });

    const prepared = await subject.prepare(root);
    await prepared.dispose();

    expect(prepared.plan.ready).toBe(false);
    const check = prepared.plan.checks.find((entry) => entry.name === "cdk library");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("doesn't keep v0 resource names");
    await expect(prepared.apply()).rejects.toThrow("isn't ready");
  });

  test("the library override warns, and the project still gets the vended library", async () => {
    const root = await committedProject();
    const { subject } = migrator({
      vendedVersion: "1.0.0-rc.3",
      env: { [CDK_LIBRARY_OVERRIDE_ENV]: "/tmp/agentcore-cdk-test.tgz" },
    });

    const prepared = await subject.prepare(root);
    expect(prepared.plan.ready).toBe(true);
    expect(prepared.plan.warnings.join("\n")).toContain(`${CDK_LIBRARY_OVERRIDE_ENV} is set`);
    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.migrated).toBe(true);
    const manifest = await readJson(join(root, "agentcore", "cdk", "package.json"));
    expect(manifest.dependencies["@aws/agentcore-cdk"]).toBe("1.0.0-rc.3");
    expect(JSON.stringify(manifest)).not.toContain("agentcore-cdk-test.tgz");
  });

  test("with several deployed targets, migrates the one --target names and records the rest", async () => {
    const root = await committedProject(twoTargets());
    const stacks = [
      { name: STACK, target: "default" },
      { name: PROD_STACK, target: "prod" },
    ];
    const first = migrator({ stacks });

    // Without --target, the plan asks for one.
    const unselected = await first.subject.prepare(root);
    await unselected.dispose();
    expect(unselected.plan.ready).toBe(false);
    const target = unselected.plan.checks.find((check) => check.name === "target");
    expect(target?.ok).toBe(false);
    expect(target?.message).toContain("2 targets (default, prod)");
    expect(target?.message).toContain("agentcore migrate --target <name>");

    const prepared = await first.subject.prepare(root, { target: "default" });
    expect(prepared.plan.ready).toBe(true);
    expect(prepared.plan.selectedTarget).toBe("default");
    expect(prepared.plan.pendingTargets).toEqual(["prod"]);
    expect(prepared.plan.stacks.map((stack) => stack.stackName)).toEqual([STACK]);
    // Only the selected target's stack is read.
    expect(first.cloudFormation.calls.some((call) => call.input.StackName === PROD_STACK)).toBe(
      false,
    );
    const partial = await prepared.apply();
    await prepared.dispose();

    expect(partial.migrated).toBe(false);
    expect(partial.error).toBeUndefined();
    expect(partial.stacks.map((stack) => stack.outcome)).toEqual(["refactored"]);
    expect(partial.pendingTargets).toEqual(["prod"]);
    expect((await readJson(join(root, "agentcore", "agentcore.json"))).migratedFrom).toBe("v1");
    // Deploying the pending target is blocked; the migrated one isn't.
    await expect(assertNoPendingMigration(root, "prod")).rejects.toThrow(
      "agentcore migrate --target prod",
    );
    await assertNoPendingMigration(root, "default");

    // The rerun plans prod afresh, from the v1 project and the still-v0 stack.
    const rerun = migrator({ stacks, sharedCloudFormation: first.cloudFormation });
    const finishing = await rerun.subject.prepare(root, { target: "prod" });
    expect(finishing.plan.finishPending).toBe(true);
    expect(finishing.plan.ready).toBe(true);
    expect(finishing.plan.stacks.map((stack) => stack.stackName)).toEqual([PROD_STACK]);
    expect(finishing.plan.stacks[0]?.moves.length).toBeGreaterThan(0);
    const finished = await finishing.apply();
    await finishing.dispose();

    expect(finished.migrated).toBe(true);
    expect(await rerun.subject.hasPendingMigration(root)).toBe(false);
    await assertNoPendingMigration(root, "prod");
  });

  test("blocks a target in an account other than the active credentials'", async () => {
    const root = await committedProject();
    const { subject } = migrator({ account: "111111111111" });

    const prepared = await subject.prepare(root);
    await prepared.dispose();

    expect(prepared.plan.ready).toBe(false);
    const check = prepared.plan.checks.find((entry) => entry.name === "stack (default)");
    expect(check?.message).toBe(
      "Target 'default' is in AWS account 998846730471 (us-east-1), but the active credentials " +
        "belong to account 111111111111. Switch to credentials for account 998846730471 and run " +
        "`agentcore migrate --target default` again.",
    );
  });

  test("a rerun finds a refactor whose Execute call failed but ran, and finishes", async () => {
    const root = await committedProject();
    const first = migrator({
      cloudFormation: {
        refactors: () => ({ executeThrows: { message: "socket hang up", started: true } }),
      },
    });
    const prepared = await first.subject.prepare(root);
    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.stacks[0]?.outcome).toBe("needs-repair");
    expect(result.restored).toBeUndefined();
    const state = await readMigrationState(root);
    expect(state?.targets[0]).toMatchObject({ status: "refactoring", refactorId: "refactor-1" });

    const rerun = migrator({ sharedCloudFormation: first.cloudFormation });
    const finishing = await rerun.subject.prepare(root);
    expect(finishing.plan.checks).toContainEqual({
      name: "refactor (default)",
      ok: true,
      message: `refactor refactor-1 of ${STACK} finished`,
    });
    expect(finishing.plan.ready).toBe(true);
    const finished = await finishing.apply();
    await finishing.dispose();

    expect(finished.migrated).toBe(true);
    expect(await rerun.subject.hasPendingMigration(root)).toBe(false);
  });

  test("a rerun finds a refactor that never ran, and plans and refactors it again", async () => {
    const root = await committedProject();
    const first = migrator({
      cloudFormation: {
        refactors: ({ index }) =>
          index === 0 ? { executeThrows: { message: "connection reset", started: false } } : {},
      },
    });
    const prepared = await first.subject.prepare(root);
    const result = await prepared.apply();
    await prepared.dispose();
    expect(result.stacks[0]?.outcome).toBe("needs-repair");

    const rerun = migrator({ sharedCloudFormation: first.cloudFormation });
    const finishing = await rerun.subject.prepare(root);
    expect(
      finishing.plan.checks.find((check) => check.name === "refactor (default)")?.message,
    ).toContain("didn't run");
    expect(finishing.plan.stacks.map((stack) => stack.stackName)).toEqual([STACK]);
    const finished = await finishing.apply();
    await finishing.dispose();

    expect(finished.migrated).toBe(true);
  });

  test("undoes a migration stopped while writing the files", async () => {
    const root = await committedProject();
    const spec = join(root, "agentcore", "agentcore.json");
    const original = await readFile(spec, "utf8");
    const saved = join(root, BACKUP_RELATIVE_PATH, "files", "agentcore", "agentcore.json");
    await mkdir(dirname(saved), { recursive: true });
    await writeFile(saved, original);
    await writeFile(spec, '{"version":2,"name":"CompatA","migratedFrom":"v1"}\n');
    await writeMigrationState(root, {
      version: 2,
      startedAt: "2026-10-13T00:00:00.000Z",
      files: {
        status: "writing",
        backup: BACKUP_RELATIVE_PATH,
        changes: [{ path: "agentcore/agentcore.json", kind: "modified" }],
      },
      refactored: [],
      targets: [
        {
          name: "default",
          account: "998846730471",
          region: "us-east-1",
          stackName: STACK,
          status: "pending",
        },
      ],
    });
    // Until it's undone, nothing deploys.
    await expect(assertNoPendingMigration(root, "default")).rejects.toThrow(
      "stopped while writing the project files",
    );

    const { subject } = migrator();
    const prepared = await subject.prepare(root);
    expect(prepared.plan.undoInterrupted).toBe(true);
    expect(prepared.plan.ready).toBe(true);
    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.undone).toBe(true);
    expect(await readFile(spec, "utf8")).toBe(original);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });
});

function twoTargets(): V0ProjectFiles {
  return {
    targets: [
      { name: "default", account: "998846730471", region: "us-east-1" },
      { name: "prod", account: "998846730471", region: "us-west-2" },
    ],
    deployedState: {
      ...F1_DEPLOYED_STATE,
      targets: {
        default: F1_DEPLOYED_STATE.targets.default,
        prod: {
          ...F1_DEPLOYED_STATE.targets.default,
          resources: { ...F1_DEPLOYED_STATE.targets.default.resources, stackName: PROD_STACK },
        },
      },
    },
  };
}
