import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileChange } from "../../../handlers/project/migrate/types";
import type { ProcessRunner } from "../../../io";
import {
  actionsMismatch,
  applyMigration,
  physicalIdChanges,
  undoInterruptedMigration,
  type ApplierConfig,
  type ApplyTarget,
} from "./apply";
import { BACKUP_RELATIVE_PATH, type ProjectFilesBackup } from "./files";
import {
  readMigrationState,
  STATE_RELATIVE_PATH,
  writeMigrationState,
  type MigrationState,
} from "./journal";
import {
  fakeCloudFormation,
  moveActions,
  NO_WAIT,
  stackResources,
} from "./migrate-cfn-test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-apply-"));
  roots.push(root);
  return root;
}

const CHANGES: FileChange[] = [{ path: "agentcore/agentcore.json", kind: "modified" }];

/** An error the AWS SDK raises for a CloudFormation 4xx answer. */
function clientError(message: string): Error {
  return Object.assign(new Error(message), { $metadata: { httpStatusCode: 400 } });
}

/** A scripted target whose refactor succeeds unless the script says otherwise. */
function target(
  name: string,
  script: {
    execute?: unknown[];
    executeCall?: unknown;
    actions?: Array<[string, string]>;
    after?: Array<[string, string]>;
  } = {},
): { entry: ApplyTarget; sent: ReturnType<typeof fakeCloudFormation>["sent"] } {
  const stackName = `AgentCore-Proj-${name}`;
  const { client, sent } = fakeCloudFormation({
    ListStackResources: [
      stackResources([
        ["OldMemory", `mem-${name}`],
        ["CDKMetadata", "meta"],
      ]),
      stackResources(
        script.after ?? [
          ["NewMemory", `mem-${name}`],
          ["CDKMetadata", "meta"],
        ],
      ),
    ],
    CreateStackRefactor: [{ StackRefactorId: `rf-${name}` }],
    DescribeStackRefactor: [
      { Status: "CREATE_COMPLETE" },
      ...((script.execute as object[] | undefined) ?? [{ ExecutionStatus: "EXECUTE_COMPLETE" }]),
    ],
    ListStackRefactorActions: [
      moveActions(stackName, script.actions ?? [["OldMemory", "NewMemory"]]),
    ],
    ExecuteStackRefactor: [script.executeCall ?? {}],
  });
  return {
    entry: {
      target: { name, account: "111111111111", region: "us-east-1" },
      stackName,
      renames: new Map([["OldMemory", "NewMemory"]]),
      bridge: { Resources: { NewMemory: { Type: "AWS::BedrockAgentCore::Memory" } } },
      client,
      templates: async () => ({ put: async () => "", remove: async () => {} }),
    },
    sent,
  };
}

/** A fresh migration's record: files to write, and `targets` pending. */
function freshState(...targets: string[]): MigrationState {
  return {
    version: 2,
    startedAt: "2026-10-13T00:00:00.000Z",
    files: { status: "writing", backup: BACKUP_RELATIVE_PATH, changes: CHANGES },
    refactored: [],
    targets: targets.map((name) => ({
      name,
      account: "111111111111",
      region: "us-east-1",
      stackName: `AgentCore-Proj-${name}`,
      status: "pending",
    })),
  };
}

/** Records writes and whether they were put back or kept. */
function fakeFiles() {
  const events: string[] = [];
  const backup: ProjectFilesBackup = {
    restore: async () => void events.push("restore"),
    discard: async () => void events.push("discard"),
  };
  const writeFiles = (async () => {
    events.push("write");
    return backup;
  }) as unknown as NonNullable<ApplierConfig["writeFiles"]>;
  return { events, writeFiles };
}

function config(
  rootPath: string,
  state: MigrationState,
  entry: ApplyTarget | undefined,
  files = fakeFiles(),
) {
  const npm: string[][] = [];
  const runner: ProcessRunner = async (args) => {
    npm.push(args);
  };
  /** Every record saved, in order. */
  const saved: MigrationState[] = [];
  const applier: ApplierConfig = {
    rootPath,
    state,
    files: { workspaceDirectory: "/unused", writeCdkApp: async () => {} },
    ...(entry && { target: entry }),
    runner,
    poll: NO_WAIT,
    writeFiles: files.writeFiles,
    saveState: async (root, next) => {
      saved.push(structuredClone(next));
      await writeMigrationState(root, next);
    },
  };
  return { applier, npm, events: files.events, saved };
}

describe("applyMigration", () => {
  test("records each step first, then writes, installs, refactors, and verifies", async () => {
    const root = tempRoot();
    const { entry, sent } = target("default");
    const { applier, npm, events, saved } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(result.stacks).toEqual([
      {
        target: "default",
        stackName: "AgentCore-Proj-default",
        region: "us-east-1",
        outcome: "refactored",
        refactorId: "rf-default",
      },
    ]);
    expect(result.files).toEqual(CHANGES);
    expect(events).toEqual(["write"]);
    expect(npm[0]?.slice(0, 2)).toEqual(["npm", "install"]);
    expect(sent.map((command) => command.name)).toContain("ExecuteStackRefactor");
    // The record was on disk before the files, and held the refactor's ID while it ran.
    expect(saved.map((state) => state.files?.status)).toEqual([
      "writing",
      "written",
      "installed",
      "installed",
    ]);
    expect(saved[3]?.targets[0]).toMatchObject({ status: "refactoring", refactorId: "rf-default" });
    expect(saved[3]?.targets[0]?.renames).toEqual([["OldMemory", "NewMemory"]]);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });

  test("changes nothing when the record can't be written", async () => {
    const root = tempRoot();
    const { entry, sent } = target("default");
    const { applier, events } = config(root, freshState("default"), entry);
    applier.saveState = async () => {
      throw new Error("read-only file system");
    };

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(false);
    expect(result.error).toContain("read-only file system");
    expect(result.error).toContain("nothing was changed");
    expect(events).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  test("doesn't execute when CloudFormation's actions differ, and puts the v0 files back", async () => {
    const root = tempRoot();
    const { entry, sent } = target("default", { actions: [["OldMemory", "Elsewhere"]] });
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.stacks[0]?.outcome).toBe("mismatch");
    expect(result.error).toContain("unplanned move OldMemory → Elsewhere");
    expect(sent.some((command) => command.name === "ExecuteStackRefactor")).toBe(false);
    expect(events).toEqual(["write", "restore"]);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });

  test("a rolled-back refactor of the only target puts the v0 files back", async () => {
    const root = tempRoot();
    const { entry } = target("default", {
      execute: [{ ExecutionStatus: "ROLLBACK_COMPLETE", ExecutionStatusReason: "no" }],
    });
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks[0]?.outcome).toBe("failed");
    expect(result.restored).toBe(true);
    expect(events).toEqual(["write", "restore"]);
  });

  test("an Execute request CloudFormation refused (4xx) didn't start: the files are put back", async () => {
    const root = tempRoot();
    const { entry } = target("default", { executeCall: clientError("Throttling: rate exceeded") });
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks[0]?.outcome).toBe("failed");
    expect(result.stacks[0]?.message).toContain("refused to start");
    expect(result.restored).toBe(true);
    expect(events).toEqual(["write", "restore"]);
  });

  test("an Execute request whose outcome isn't known stops with the files and the refactor ID", async () => {
    const root = tempRoot();
    const { entry } = target("default", { executeCall: new Error("socket hang up") });
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks[0]?.outcome).toBe("needs-repair");
    expect(result.restored).toBeUndefined();
    expect(events).toEqual(["write"]);
    const recovery = result.recovery.join("\n");
    expect(recovery).toContain(
      "aws cloudformation describe-stack-refactor --stack-refactor-id rf-default --region us-east-1",
    );
    expect(recovery).toContain(
      "aws cloudformation list-stack-resources --stack-name AgentCore-Proj-default --region us-east-1",
    );
    const state = await readMigrationState(root);
    expect(state?.targets[0]).toMatchObject({ status: "refactoring", refactorId: "rf-default" });
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(true);
  });

  test("with several deployed targets, refactors the selected one and records the rest", async () => {
    const root = tempRoot();
    const { entry } = target("dev");
    const { applier, events } = config(root, freshState("dev", "prod", "test"), entry);

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.stacks.map((stack) => stack.outcome)).toEqual(["refactored"]);
    expect(result.pendingTargets).toEqual(["prod", "test"]);
    expect(result.stateFile).toBe("agentcore/.cli/migration-state.json");
    expect(result.recovery.join("\n")).toContain("agentcore migrate --target prod");
    expect(events).toEqual(["write"]);
    const state = await readMigrationState(root);
    expect(state?.refactored).toEqual(["dev"]);
    expect(state?.targets.map((pending) => [pending.name, pending.status])).toEqual([
      ["prod", "pending"],
      ["test", "pending"],
    ]);
    // No precomputed refactor is stored for targets not migrated yet.
    expect(state?.targets.every((pending) => pending.renames === undefined)).toBe(true);
    // Once a stack has v1 IDs the v0 files can't come back: the backup is gone.
    expect(existsSync(join(root, BACKUP_RELATIVE_PATH))).toBe(false);
  });

  test("finishing a pending target doesn't rewrite files, and clears the record when it's the last", async () => {
    const root = tempRoot();
    const { entry } = target("prod");
    const state = { ...freshState("prod"), refactored: ["dev"] };
    state.files!.status = "installed";
    const { applier, events, npm } = config(root, state, entry);
    delete applier.files;

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(events).toEqual([]);
    expect(npm).toEqual([]);
    expect(await readMigrationState(root)).toBeUndefined();
  });

  test("finishing installs the CDK app's dependencies when an earlier run stopped before", async () => {
    const root = tempRoot();
    const state = freshState();
    state.files!.status = "written";
    const { applier, npm } = config(root, state, undefined);
    delete applier.files;

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(npm[0]?.slice(0, 2)).toEqual(["npm", "install"]);
  });

  test("finishing records a refactor found complete and clears the record", async () => {
    const root = tempRoot();
    const state = freshState("prod");
    state.files!.status = "installed";
    state.targets[0]!.status = "refactoring";
    state.targets[0]!.refactorId = "rf-prod";
    const { applier } = config(root, state, undefined);
    delete applier.files;
    applier.completed = ["prod"];

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(await readMigrationState(root)).toBeUndefined();
  });

  test("finishing puts back the v0 files from the backup when nothing was ever refactored", async () => {
    const root = tempRoot();
    const spec = join(root, "agentcore", "agentcore.json");
    const saved = join(root, BACKUP_RELATIVE_PATH, "files", "agentcore", "agentcore.json");
    mkdirSync(dirname(spec), { recursive: true });
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(spec, '{"version":2}\n');
    writeFileSync(saved, '{"version":1}\n');
    const { entry } = target("default", { execute: [{ ExecutionStatus: "ROLLBACK_COMPLETE" }] });
    const state = freshState("default");
    state.files!.status = "installed";
    const { applier } = config(root, state, entry);
    delete applier.files;

    const result = await applyMigration(applier);

    expect(result.restored).toBe(true);
    expect(readFileSync(spec, "utf8")).toBe('{"version":1}\n');
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });

  test("a physical ID that changed asks for a look and keeps the refactor ID", async () => {
    const root = tempRoot();
    const { entry } = target("dev", {
      after: [
        ["NewMemory", "mem-other"],
        ["CDKMetadata", "meta"],
      ],
    });
    const { applier } = config(root, freshState("dev"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks.map((stack) => stack.outcome)).toEqual(["needs-repair"]);
    expect(result.restored).toBeUndefined();
    expect(result.recovery.join("\n")).toContain(
      "describe-stack-refactor --stack-refactor-id rf-dev",
    );
    expect((await readMigrationState(root))?.targets[0]?.refactorId).toBe("rf-dev");
  });

  test("Ctrl-C before the refactor starts puts the v0 files back", async () => {
    const root = tempRoot();
    const { entry, sent } = target("dev");
    const { applier, events } = config(root, freshState("dev"), entry);
    const steps: string[] = [];
    const listenersBefore = process.listenerCount("SIGINT");

    const result = await applyMigration(applier, {
      onStep: (message) => {
        steps.push(message);
        if (message.startsWith("Installing")) process.emit("SIGINT");
      },
    });

    expect(result.stacks.map((stack) => stack.outcome)).toEqual(["not-started"]);
    expect(sent.some((command) => command.name === "CreateStackRefactor")).toBe(false);
    expect(steps.some((step) => step.startsWith("Stopping once the current step ends"))).toBe(true);
    expect(result.restored).toBe(true);
    expect(events).toEqual(["write", "restore"]);
    // The Ctrl-C handler is removed once applying ends.
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });

  test("a failed file write puts back what was written and clears the record", async () => {
    const root = tempRoot();
    const { entry, sent } = target("default");
    const { applier } = config(root, freshState("default"), entry);
    applier.writeFiles = (async () => {
      throw new Error("disk full");
    }) as unknown as NonNullable<ApplierConfig["writeFiles"]>;

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(false);
    expect(result.error).toBe("disk full");
    expect(sent).toHaveLength(0);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });

  test("a project with no deployed target only converts its files", async () => {
    const root = tempRoot();
    const { applier, events } = config(root, freshState(), undefined);

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(result.stacks).toEqual([]);
    expect(events).toEqual(["write"]);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
  });
});

describe("undoInterruptedMigration", () => {
  test("puts the v0 files back from the backup and deletes the record", async () => {
    const root = tempRoot();
    const spec = join(root, "agentcore", "agentcore.json");
    const added = join(root, "app", "h", "harness.yaml");
    const saved = join(root, BACKUP_RELATIVE_PATH, "files", "agentcore", "agentcore.json");
    for (const path of [spec, added, saved]) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(spec, '{"version":2}\n');
    writeFileSync(added, "name: h\n");
    writeFileSync(saved, '{"version":1}\n');
    const state: MigrationState = {
      ...freshState(),
      files: {
        status: "writing",
        backup: BACKUP_RELATIVE_PATH,
        changes: [...CHANGES, { path: "app/h/harness.yaml", kind: "added" }],
      },
    };
    await writeMigrationState(root, state);

    const result = await undoInterruptedMigration(root, state);

    expect(result.undone).toBe(true);
    expect(readFileSync(spec, "utf8")).toBe('{"version":1}\n');
    expect(existsSync(added)).toBe(false);
    expect(existsSync(join(root, STATE_RELATIVE_PATH))).toBe(false);
    expect(existsSync(join(root, BACKUP_RELATIVE_PATH))).toBe(false);
  });
});

describe("actionsMismatch", () => {
  const renames = new Map([
    ["A", "B"],
    ["C", "D"],
  ]);
  const action = (from: string, to: string, kind = "MOVE") => ({
    action: kind,
    entity: "RESOURCE",
    from,
    to,
  });

  test("matching actions", () => {
    expect(actionsMismatch([action("A", "B"), action("C", "D")], renames)).toBeUndefined();
  });

  test("missing, unplanned, and non-MOVE actions", () => {
    expect(actionsMismatch([action("A", "X"), action("E", "F", "CREATE")], renames)).toBe(
      "unplanned move A → X, unexpected CREATE RESOURCE E → F, missing move A → B, missing move C → D",
    );
  });
});

describe("physicalIdChanges", () => {
  test("follows moved resources to their new logical IDs", () => {
    const renames = new Map([["Old", "New"]]);
    expect(
      physicalIdChanges(
        new Map([
          ["Old", "p1"],
          ["Same", "p2"],
        ]),
        new Map([
          ["New", "p1"],
          ["Same", "p2"],
        ]),
        renames,
      ),
    ).toEqual([]);
    expect(physicalIdChanges(new Map([["Old", "p1"]]), new Map([["New", "p9"]]), renames)).toEqual([
      "Old was p1, New is p9",
    ]);
    expect(physicalIdChanges(new Map([["Old", "p1"]]), new Map(), renames)).toEqual([
      "Old was p1, New is missing",
    ]);
  });
});

describe("applyMigration retaining unsupported resources", () => {
  const DATASET = "ApplicationDatasetGolden8AF7116D";
  const retained = {
    Resources: {
      OldMemory: { Type: "AWS::BedrockAgentCore::Memory" },
      [DATASET]: {
        Type: "AWS::BedrockAgentCore::Dataset",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      },
    },
  };
  const stack = (status: string) => ({
    Stacks: [{ StackName: "AgentCore-Proj-default", StackStatus: status, Parameters: [] }],
  });
  const policyChange = {
    Type: "Resource",
    ResourceChange: {
      Action: "Modify",
      LogicalResourceId: DATASET,
      Replacement: "False",
      Details: [
        { Target: { Attribute: "DeletionPolicy" } },
        { Target: { Attribute: "UpdateReplacePolicy" } },
      ],
    },
  };

  function retainingTarget(execute: unknown = {}) {
    const { client, sent } = fakeCloudFormation({
      DescribeStacks: [
        stack("UPDATE_COMPLETE"),
        stack("UPDATE_IN_PROGRESS"),
        stack("UPDATE_COMPLETE"),
      ],
      CreateChangeSet: [{ Id: "cs" }],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", Changes: [policyChange] }],
      ExecuteChangeSet: [execute],
      GetTemplate: [{ TemplateBody: JSON.stringify(retained) }],
      ListStackResources: [
        stackResources([
          ["OldMemory", "mem"],
          [DATASET, "ds"],
        ]),
        stackResources([
          ["NewMemory", "mem"],
          [DATASET, "ds"],
        ]),
      ],
      CreateStackRefactor: [{ StackRefactorId: "rf-default" }],
      DescribeStackRefactor: [
        { Status: "CREATE_COMPLETE" },
        { ExecutionStatus: "EXECUTE_COMPLETE" },
      ],
      ListStackRefactorActions: [
        moveActions("AgentCore-Proj-default", [["OldMemory", "NewMemory"]]),
      ],
      ExecuteStackRefactor: [{}],
    });
    const entry: ApplyTarget = {
      target: { name: "default", account: "111111111111", region: "us-east-1" },
      stackName: "AgentCore-Proj-default",
      renames: new Map([["OldMemory", "NewMemory"]]),
      bridge: {
        Resources: {
          NewMemory: retained.Resources.OldMemory,
          [DATASET]: retained.Resources[DATASET],
        },
      },
      retain: { template: retained, logicalIds: new Set([DATASET]) },
      client,
      templates: async () => ({ put: async () => "", remove: async () => {} }),
    };
    return { entry, sent };
  }

  test("sets the retain policies before the refactor, recording the change set while it runs", async () => {
    const root = tempRoot();
    const { entry, sent } = retainingTarget();
    const { applier, saved } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.migrated).toBe(true);
    expect(result.stacks[0]).toMatchObject({ outcome: "refactored", refactorId: "rf-default" });
    expect(result.stacks[0]?.retainChangeSet).toStartWith("agentcore-migrate-retain-");
    const names = sent.map((command) => command.name);
    expect(names.indexOf("ExecuteChangeSet")).toBeLessThan(names.indexOf("CreateStackRefactor"));
    const statuses = saved.flatMap((state) => state.targets.map((t) => t.status));
    expect(statuses).toContain("retaining");
    expect(statuses.indexOf("retaining")).toBeLessThan(statuses.indexOf("refactoring"));
  });

  test("an unknown retain outcome stops before the refactor, with the change set's check commands", async () => {
    const root = tempRoot();
    const { entry, sent } = retainingTarget(new Error("socket hang up"));
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks[0]?.outcome).toBe("needs-repair");
    expect(sent.some((command) => command.name === "CreateStackRefactor")).toBe(false);
    // An update whose outcome isn't known may have run, so the files stay as written.
    expect(result.restored).toBeUndefined();
    expect(events).toEqual(["write"]);
    const recovery = result.recovery.join("\n");
    expect(recovery).toContain(
      "aws cloudformation describe-change-set --stack-name AgentCore-Proj-default",
    );
    expect(recovery).toContain("agentcore migrate --target default");
    expect(recovery).not.toContain("describe-stack-refactor");
    const state = await readMigrationState(root);
    expect(state?.targets[0]).toMatchObject({ status: "retaining" });
  });

  test("a retain update CloudFormation refused puts the v0 files back", async () => {
    const root = tempRoot();
    const { entry } = retainingTarget(clientError("ValidationError"));
    const { applier, events } = config(root, freshState("default"), entry);

    const result = await applyMigration(applier);

    expect(result.stacks[0]?.outcome).toBe("failed");
    expect(result.restored).toBe(true);
    expect(events).toEqual(["write", "restore"]);
  });
});
