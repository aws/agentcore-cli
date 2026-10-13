import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSilentLogger } from "../../../testing";
import {
  credentialNameWarnings,
  deployedTargets,
  FsProjectMigrator,
  sharedEnvironmentWarnings,
} from "./index";
import {
  commitAll,
  F1_DEPLOYED_STATE,
  F1_SPEC,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeGit,
  fakeSynth,
  templateFixture,
  writeV0Project,
  type FakeStack,
  type V0ProjectFiles,
  vendedAssets,
} from "./migrate-test-support";
import type { WorkspaceSynthesizer } from "./synth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

const STACK = "AgentCore-CompatA-default";

/**
 * The real migrator with its AWS and synth seams faked: F1's stack is deployed
 * with the live-tested CompatMig template, and the v1 app "synthesizes" the
 * CompatMig v1 template, which keeps every deployed AgentCore resource.
 */
function fakes(
  options: {
    stacks?: Record<string, FakeStack>;
    synthesize?: WorkspaceSynthesizer;
    /** Run real git rather than answering it from a script. */
    realGit?: boolean;
    account?: string;
  } = {},
) {
  const cloudFormation = fakeCloudFormation(
    options.stacks ?? { [STACK]: { template: templateFixture("pinned.v0") } },
  );
  const synthesize =
    options.synthesize ??
    fakeSynth([{ target: "default", stackName: STACK, template: templateFixture("pinned.v1") }]);
  const migrator = new FsProjectMigrator({
    logger: createSilentLogger(),
    ...(!options.realGit && { runner: fakeGit({ status: "" }) }),
    assetSource: vendedAssets(),
    createCloudFormationClient: cloudFormation.create,
    resolveCredentials: FAKE_AWS_IDENTITY.resolveCredentials,
    resolveAccount: async () => options.account ?? "998846730471",
    synthesize,
  });
  return { migrator, cloudFormation, synthesize };
}

const migrator = () => fakes().migrator;

describe("FsProjectMigrator.plan", () => {
  test("plans a deployed v0 project committed to git, without touching it", async () => {
    const root = await project();
    commitAll(root);
    const before = await readFile(join(root, "agentcore", "agentcore.json"), "utf8");

    // The real process runner, so the git check runs real git.
    const plan = await fakes({ realGit: true }).migrator.plan(root);

    expect(plan.ready).toBe(true);
    expect(plan.projectName).toBe("CompatA");
    expect(plan.checks.every((check) => check.ok)).toBe(true);
    expect(plan.problems).toEqual([]);
    // Every pin convertSpec makes for F1, plus the harness role it can name only from harness.json.
    expect(plan.pins).toHaveLength(9);
    expect(plan.pins).toContainEqual({
      resourceType: "harness-role",
      name: "CompatAHarness",
      value: "CompatA_CompatAHarness",
      targets: ["default"],
    });
    expect(plan.warnings).toEqual([
      "Dropped fields v1 doesn't use: credentials[compatA-oauth].usage",
      expect.stringContaining("This project has credentials (compatA-key, compatA-oauth)."),
    ]);
    // The project isn't written; deployed state isn't part of the migration.
    expect(plan.changes).not.toContainEqual(
      expect.objectContaining({ path: "agentcore/.cli/deployed-state.json" }),
    );
    expect(plan.skippedStacks).toEqual([]);
    expect(plan.cdkLibraryOverride).toBeUndefined();
    expect(plan.changes).toContainEqual({ path: "agentcore/agentcore.json", kind: "modified" });
    expect(plan.changes).toContainEqual({ path: "app/CompatAHarness/harness.yaml", kind: "added" });
    expect(plan.changes).toContainEqual({
      path: "app/CompatAHarness/harness.json",
      kind: "removed",
    });
    expect(await readFile(join(root, "agentcore", "agentcore.json"), "utf8")).toBe(before);
  });

  test("plans only the target --target names, and blocks one in another account", async () => {
    const memory = (id: string) => ({
      memories: {
        CompatAAgentMemory: {
          memoryId: id,
          memoryArn: `arn:aws:bedrock-agentcore:us-west-2:998846730471:memory/${id}`,
        },
      },
    });
    const root = await project({
      targets: [
        { name: "default", account: "998846730471", region: "us-east-1" },
        { name: "prod", account: "998846730471", region: "us-west-2" },
        { name: "other", account: "111111111111", region: "eu-west-1" },
      ],
      deployedState: {
        targets: {
          ...F1_DEPLOYED_STATE.targets,
          // prod and other deployed only the memory.
          prod: { resources: memory("CompatA_CompatAAgentMemory-Pr0dPr0dPr") },
          other: { resources: memory("CompatA_CompatAAgentMemory-0th3r0th3r") },
        },
      },
    });
    commitAll(root);
    const v0 = templateFixture("pinned.v0");
    const v1 = templateFixture("pinned.v1");
    const { migrator } = fakes({
      realGit: true,
      stacks: {
        [STACK]: { template: v0 },
        "AgentCore-CompatA-prod": { template: v0 },
        "AgentCore-CompatA-other": { template: v0 },
      },
      synthesize: fakeSynth([
        { target: "default", stackName: STACK, template: v1 },
        { target: "prod", stackName: "AgentCore-CompatA-prod", template: v1 },
        { target: "other", stackName: "AgentCore-CompatA-other", template: v1 },
      ]),
    });

    // Several deployed targets: the plan asks which one to migrate.
    const unselected = await migrator.plan(root);
    expect(unselected.stacks).toEqual([]);
    expect(unselected.checks.find((check) => check.name === "target")).toEqual({
      name: "target",
      ok: false,
      message:
        "This project is deployed to 3 targets (default, prod, other). Migrate one target at a " +
        "time: run `agentcore migrate --target <name>`.",
    });
    expect(unselected.ready).toBe(false);

    const plan = await migrator.plan(root, { target: "prod" });

    const pin = (resourceType: string, name: string) =>
      plan.pins.find((entry) => entry.resourceType === resourceType && entry.name === name);
    // Each kept name lists the targets that deployed the resource.
    expect(pin("memory", "CompatAAgentMemory")?.targets).toEqual(["default", "prod", "other"]);
    expect(pin("runtime", "CompatAAgent")?.targets).toEqual(["default"]);
    // Only the selected target is planned; the others are recorded as pending.
    expect(plan.stacks.map((stack) => stack.target)).toEqual(["prod"]);
    expect(plan.selectedTarget).toBe("prod");
    expect(plan.pendingTargets).toEqual(["default", "other"]);
    expect(plan.checks.find((check) => check.name === "target")?.message).toBe(
      "migrating 'prod' (998846730471/us-west-2); default, other stay pending until migrated with --target",
    );

    // A target in another account is blocked, naming both accounts and the region.
    const other = await migrator.plan(root, { target: "other" });
    expect(other.skippedStacks).toEqual([
      {
        target: "other",
        reason:
          "Target 'other' is in AWS account 111111111111 (eu-west-1), but the active " +
          "credentials belong to account 998846730471. Switch to credentials for account " +
          "111111111111 and run `agentcore migrate --target other` again.",
      },
    ]);
    expect(other.ready).toBe(false);
  });

  test("still plans the stacks when the git check fails", async () => {
    const root = await project();
    commitAll(root);
    await writeFile(join(root, "notes.txt"), "wip\n");
    const plan = await fakes({ realGit: true }).migrator.plan(root);
    expect(plan.checks.find((check) => check.name === "git")?.ok).toBe(false);
    expect(plan.stacks).toHaveLength(1);
    expect(plan.stacks[0]?.ready).toBe(true);
    expect(plan.ready).toBe(false);
  });

  test("fails the git check for uncommitted changes", async () => {
    const root = await project();
    commitAll(root);
    await writeFile(join(root, "notes.txt"), "wip\n");
    const plan = await fakes({ realGit: true }).migrator.plan(root);
    expect(plan.ready).toBe(false);
    expect(plan.checks.find((check) => check.name === "git")?.message).toContain("?? notes.txt");
  });

  test("returns only the format check for a project that isn't v0", async () => {
    const plan = await migrator().plan(await project({ spec: { name: "Already", version: 2 } }));
    expect(plan).toMatchObject({ ready: false, pins: [], changes: [], problems: [] });
    expect(plan.projectName).toBeUndefined();
    expect(plan.checks.map((check) => check.name)).toEqual(["v0 project"]);
  });

  test("collects problems from the spec, harnesses, and deployment targets", async () => {
    const plan = await migrator().plan(
      await project({
        spec: {
          ...F1_SPEC,
          credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "ab" }],
        },
        targets: [{ name: "prod-us", account: "998846730471", region: "us-east-1" }],
        files: { "app/CompatAHarness/harness.json": JSON.stringify({ name: "CompatAHarness" }) },
        deployedState: null,
      }),
    );
    expect(plan.ready).toBe(false);
    // A hyphenated target name (prod-us) is valid in v1 too, so only the spec and harness fail.
    expect(plan.problems.map((problem) => `${problem.file} ${problem.path}`)).toEqual([
      "agentcore/agentcore.json credentials[ab].name",
      "app/CompatAHarness/harness.json model",
    ]);
    // The unconvertible harness keeps its harness.json in the plan.
    expect(plan.changes.some((change) => change.path.startsWith("app/CompatAHarness/"))).toBe(
      false,
    );
  });

  test("says why stack plans were skipped when the project doesn't convert", async () => {
    const plan = await migrator().plan(
      await project({
        spec: {
          ...F1_SPEC,
          credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "ab" }],
        },
      }),
    );
    expect(plan.problems).toHaveLength(1);
    expect(plan.stacks).toEqual([]);
    expect(plan.skippedStacks).toEqual([
      {
        reason:
          "the project doesn't convert to v1 until the issues under 'Fix before migrating' are fixed",
      },
    ]);
  });

  test("blocks a customized v0 CDK app", async () => {
    const plan = await migrator().plan(
      await project({
        files: { "agentcore/cdk/lib/cdk-stack.ts": "// my own stack\nnew Bucket(this, 'b');\n" },
      }),
    );
    expect(plan.ready).toBe(false);
    expect(plan.checks.find((check) => check.name === "cdk app")).toMatchObject({
      ok: false,
      message: expect.stringContaining("  modified  agentcore/cdk/lib/cdk-stack.ts"),
    });
  });

  test("blocks on unsupported resources and an old CDK app", async () => {
    const plan = await migrator().plan(
      await project({
        cdkPin: "0.1.0-alpha.30",
        spec: {
          ...F1_SPEC,
          datasets: [
            {
              name: "ds1",
              schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
              config: { managed: { location: "d/x.jsonl" } },
            },
          ],
        },
      }),
    );
    const failed = plan.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(["cdk dependencies", "supported resources"]);
    expect(plan.ready).toBe(false);
  });
});

describe("FsProjectMigrator.plan, deployed stacks", () => {
  test("reads each deployed stack, synthesizes the converted project, and plans the refactor", async () => {
    const root = await project();
    const subject = fakes();
    const steps: string[] = [];

    const plan = await subject.migrator.plan(root, { onStep: (step) => steps.push(step) });

    expect(plan.ready).toBe(true);
    expect(plan.checks.slice(-2)).toEqual([
      {
        name: "stack (default)",
        ok: true,
        message: `${STACK} is UPDATE_COMPLETE, with no stack policy`,
      },
      { name: "v1 synth", ok: true, message: "the converted project synthesizes" },
    ]);
    expect(subject.cloudFormation.calls).toEqual([
      { command: "DescribeStacksCommand", input: { StackName: STACK }, region: "us-east-1" },
      { command: "GetStackPolicyCommand", input: { StackName: STACK }, region: "us-east-1" },
      {
        command: "GetTemplateCommand",
        input: { StackName: STACK, TemplateStage: "Original" },
        region: "us-east-1",
      },
    ]);
    expect(plan.stacks).toHaveLength(1);
    expect(plan.stacks[0]).toMatchObject({
      target: "default",
      account: "998846730471",
      region: "us-east-1",
      stackName: STACK,
      unchanged: 5,
      added: [],
      replaced: [],
      blockers: [],
      ready: true,
    });
    expect(plan.stacks[0]!.moves).toHaveLength(10);
    expect(steps).toEqual([
      `Reading stack ${STACK} (998846730471/us-east-1)`,
      `Planning the refactor of ${STACK}`,
    ]);
  });

  test("synthesizes the converted copy, not the project", async () => {
    const root = await project();
    const seen: string[] = [];
    const synth = fakeSynth([
      { target: "default", stackName: STACK, template: templateFixture("pinned.v1") },
    ]);
    const subject = fakes({
      synthesize: async (workspace, options) => {
        seen.push(await readFile(join(workspace, "agentcore", "agentcore.json"), "utf8"));
        return synth(workspace, options);
      },
    });

    await subject.migrator.plan(root);

    expect(synth.workspaces).toHaveLength(1);
    expect(synth.workspaces[0]).not.toBe(root);
    expect(JSON.parse(seen[0]!)).toMatchObject({ name: "CompatA", version: 2 });
  });

  test("reports a v1 deploy that would replace an AgentCore resource", async () => {
    const subject = fakes({
      stacks: { [STACK]: { template: templateFixture("codezip.v0") } },
      synthesize: fakeSynth([
        { target: "default", stackName: STACK, template: templateFixture("codezip.v1-rc3") },
      ]),
    });

    const plan = await subject.migrator.plan(await project());

    expect(plan.ready).toBe(false);
    expect(plan.checks.every((check) => check.ok)).toBe(true);
    expect(plan.stacks[0]!.ready).toBe(false);
    expect(
      plan.stacks[0]!.replaced.filter((change) => change.severity === "blocker"),
    ).toMatchObject([{ type: "AWS::BedrockAgentCore::ConfigurationBundle" }]);
  });

  test("never reads AWS or synthesizes for a project that was never deployed", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({ synthesize: synth });
    const plan = await subject.migrator.plan(await project({ deployedState: null }));
    expect(plan.ready).toBe(true);
    expect(plan.stacks).toEqual([]);
    expect(subject.cloudFormation.calls).toEqual([]);
    expect(synth.workspaces).toEqual([]);
  });

  test("fails the stack check when the credentials are for another account", async () => {
    const subject = fakes({ account: "111122223333" });
    const plan = await subject.migrator.plan(await project());
    const check = plan.checks.find((entry) => entry.name === "stack (default)");
    expect(check).toMatchObject({ ok: false });
    expect(check?.message).toContain("the active credentials belong to account 111122223333");
    expect(subject.cloudFormation.calls).toEqual([]);
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("doesn't synthesize when a stack can't be refactored", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({
      stacks: {
        [STACK]: { template: templateFixture("pinned.v0"), policy: '{"Statement":[]}' },
      },
      synthesize: synth,
    });
    const plan = await subject.migrator.plan(await project());
    expect(plan.checks.find((check) => check.name === "stack (default)")?.message).toContain(
      "doesn't support stacks with a stack policy",
    );
    expect(synth.workspaces).toEqual([]);
    expect(subject.cloudFormation.calls.map((call) => call.command)).not.toContain(
      "GetTemplateCommand",
    );
    expect(plan.ready).toBe(false);
  });

  test("turns an AWS error into a failed stack check", async () => {
    const failing = new FsProjectMigrator({
      logger: createSilentLogger(),
      runner: fakeGit({ status: "" }),
      assetSource: vendedAssets(),
      createCloudFormationClient: () =>
        ({
          send: async () => {
            throw Object.assign(new Error("User is not authorized to perform DescribeStacks"), {
              name: "AccessDenied",
            });
          },
        }) as never,
      ...FAKE_AWS_IDENTITY,
      synthesize: fakeSynth([]),
    });
    const plan = await failing.plan(await project());
    expect(plan.checks.find((check) => check.name === "stack (default)")).toEqual({
      name: "stack (default)",
      ok: false,
      message: `Couldn't read stack '${STACK}' in 998846730471/us-east-1: User is not authorized to perform DescribeStacks`,
    });
  });

  test("says when the CDK library doesn't support migratedFrom yet", async () => {
    const plan = await fakes({
      synthesize: async () => {
        throw new Error(
          "'npm run cdk -- synth' failed (exit code 1).\n\nAgentCore CDK synthesis failed: " +
            'Unrecognized key: "migratedFrom"',
        );
      },
    }).migrator.plan(await project());
    const check = plan.checks.at(-1);
    expect(check).toMatchObject({ name: "v1 synth", ok: false });
    expect(check?.message).toStartWith(
      "The CDK library the v1 app synthesized with doesn't support migratedFrom yet, so it " +
        "can't keep this project's v0 resource names.",
    );
    expect(plan.ready).toBe(false);
  });

  test("reports a v1 app that doesn't synthesize", async () => {
    const plan = await fakes({
      synthesize: async () => {
        throw new Error("'npm run cdk -- synth' failed (exit code 1).\n\nboom");
      },
    }).migrator.plan(await project());
    expect(plan.checks.at(-1)).toEqual({
      name: "v1 synth",
      ok: false,
      message:
        "The converted project's v1 CDK app didn't synthesize:\n'npm run cdk -- synth' failed (exit code 1).\n\nboom",
    });
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("reports a target the v1 app has no stack for, and still returns the plan", async () => {
    const plan = await fakes({
      synthesize: fakeSynth([{ target: "other", stackName: STACK, template: {} }]),
    }).migrator.plan(await project());
    const check = plan.checks.at(-1);
    expect(check).toMatchObject({ name: "plan (default)", ok: false });
    expect(check?.message).toStartWith(
      `Couldn't plan the refactor of '${STACK}': The synthesized cloud assembly has no stack for deployment target 'default'.`,
    );
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("still checks the stacks, but doesn't synthesize, when the files need fixing first", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({ synthesize: synth });
    const plan = await subject.migrator.plan(
      await project({
        spec: {
          ...F1_SPEC,
          credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "ab" }],
        },
      }),
    );
    expect(plan.problems).not.toEqual([]);
    expect(plan.checks.find((check) => check.name === "stack (default)")?.ok).toBe(true);
    expect(synth.workspaces).toEqual([]);
  });
});

describe("deployedTargets", () => {
  const target = { name: "default", account: "998846730471", region: "us-east-1" as const };

  test("uses the recorded stack name, or derives v0's", () => {
    expect(deployedTargets("CompatA", [target], F1_DEPLOYED_STATE as never).targets).toEqual([
      { target, stackName: STACK },
    ]);
    expect(
      deployedTargets("My_Proj", [{ ...target, name: "dev_1" }], {
        targets: { dev_1: { resources: {} } },
      }).targets,
    ).toEqual([{ target: { ...target, name: "dev_1" }, stackName: "AgentCore-My-Proj-dev-1" }]);
    // A hyphenated target keeps its hyphen in the stack name; v0 resource names never include it.
    expect(
      deployedTargets("Proj", [{ ...target, name: "prod-us" }], {
        targets: { "prod-us": { resources: {} } },
      }).targets,
    ).toEqual([{ target: { ...target, name: "prod-us" }, stackName: "AgentCore-Proj-prod-us" }]);
  });

  test("skips targets with nothing deployed and fails ones missing from aws-targets.json", () => {
    const result = deployedTargets("CompatA", [], {
      targets: { gone: { resources: {} }, empty: {} },
    });
    expect(result.targets).toEqual([]);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "stack (gone)", ok: false });
    expect(result.checks[0]!.message).toContain("target 'gone', which isn't in");
  });
});

describe("sharedEnvironmentWarnings", () => {
  test("warns about targets that share an account and region, since v0 names have no target", () => {
    const warnings = sharedEnvironmentWarnings([
      { name: "default", account: "111111111111", region: "us-east-1" },
      { name: "staging", account: "111111111111", region: "us-east-1" },
      { name: "prod", account: "111111111111", region: "us-west-2" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      "Targets 'default', 'staging' are all in 111111111111/us-east-1. A migrated project keeps v0's resource names",
    );
  });

  test("says nothing for targets in different accounts or regions", () => {
    expect(
      sharedEnvironmentWarnings([
        { name: "default", account: "111111111111", region: "us-east-1" },
        { name: "prod", account: "222222222222", region: "us-east-1" },
      ]),
    ).toEqual([]);
  });
});

describe("credentialNameWarnings", () => {
  test("names the credentials whose v0 provider names the migrated project keeps", () => {
    const warnings = credentialNameWarnings(["key", "oauth"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("This project has credentials (key, oauth).");
    expect(credentialNameWarnings([])).toEqual([]);
  });
});
