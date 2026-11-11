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
import { gatewayCredentialNames, type CredentialSecretLookups } from "./credentialSecrets";
import { CDK_LIBRARY_OVERRIDE_ENV, FsProjectMigrator } from "./index";
import {
  commitAll,
  F1_DEPLOYED_STATE,
  F1_SPEC,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeSynth,
  templateFixture,
  vendedAssets,
  writeV0Project,
  type FakeCloudFormationOptions,
  type V0ProjectFiles,
} from "./migrate-test-support";
import type { WorkspaceSynthesizer } from "./synth";

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
    identity?: CredentialSecretLookups;
    /** Called with each workspace the v1 app is synthesized in, before it synthesizes. */
    onSynth?: (workspaceDirectory: string) => Promise<void>;
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
    synthesize: synthesizer(
      fakeSynth(
        stacks.map((stack) => ({
          target: stack.target,
          stackName: stack.name,
          template: templateFixture("pinned.v1"),
        })),
      ),
      options.onSynth,
    ),
    ...(options.identity && { identity: options.identity }),
    env: options.env ?? {},
    poll: { intervalMs: 0, sleep: async () => {} },
  });
  return { subject, cloudFormation, run };
}

function synthesizer(
  synthesize: WorkspaceSynthesizer,
  onSynth?: (workspaceDirectory: string) => Promise<void>,
): WorkspaceSynthesizer {
  if (!onSynth) return synthesize;
  return async (workspaceDirectory, options) => {
    await onSynth(workspaceDirectory);
    return synthesize(workspaceDirectory, options);
  };
}

/** Answers each provider's secret ARN from `secrets` (an Error is thrown), recording the calls. */
function fakeIdentity(secrets: Record<string, string | Error>) {
  const calls: string[] = [];
  const secretArn = (name: string) => {
    calls.push(name);
    const secret = secrets[name];
    if (secret instanceof Error) throw secret;
    return secret === undefined ? undefined : { secretArn: secret };
  };
  const identity: CredentialSecretLookups = {
    getApiKeyCredentialProvider: async (name) => ({ apiKeySecretArn: secretArn(name) }) as never,
    getOauth2CredentialProvider: async (name) => ({ clientSecretArn: secretArn(name) }) as never,
  };
  return Object.assign(identity, { calls });
}

const KEY_SECRET = "arn:aws:secretsmanager:us-east-1:998846730471:secret:apikey/compatA-key-AbCdEf";
const OAUTH_SECRET =
  "arn:aws:secretsmanager:us-east-1:998846730471:secret:oauth2/compatA-oauth-GhIjKl";
const STATE_PATH = join("agentcore", ".cli", "deployed-state.json");
const DENIED = "User is not authorized to perform this action";

/** The secret ARN recorded for each of a target's credentials, in the file's order. */
const secretArns = (target: unknown) =>
  Object.values(
    (target as { resources: { credentials: Record<string, { clientSecretArn?: string }> } })
      .resources.credentials,
  ).map((credential) => credential.clientSecretArn);

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** F1 with its Gateway target authenticating by OAuth, so the v1 app needs compatA-oauth's secret ARN. */
const GATEWAY_SPEC = {
  ...F1_SPEC,
  agentCoreGateways: F1_SPEC.agentCoreGateways.map((gateway) => ({
    ...gateway,
    targets: gateway.targets.map((target) => ({
      ...target,
      outboundAuth: { type: "OAUTH", credentialName: "compatA-oauth", scopes: ["openid"] },
    })),
  })),
};

/**
 * Fails the synth as v1's CDK app does: it synthesizes every target's stack, and a
 * Gateway credential recorded without a secret ARN throws.
 */
async function requireGatewaySecrets(workspace: string): Promise<void> {
  const spec = await readJson(join(workspace, "agentcore", "agentcore.json"));
  const state = await readJson(join(workspace, STATE_PATH));
  for (const target of Object.values(state.targets) as {
    resources?: { credentials?: Record<string, { clientSecretArn?: string }> };
  }[]) {
    for (const name of gatewayCredentialNames(spec)) {
      const credential = target.resources?.credentials?.[name];
      if (credential && credential.clientSecretArn === undefined) {
        throw new Error(
          `Credential "${name}" has no clientSecretArn in deployed state; the gateway role needs it to read the secret.`,
        );
      }
    }
  }
}

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

  test("records the secret ARNs v0 didn't, for the synth and in the migrated project", async () => {
    const root = await committedProject();
    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });
    const synthesized: unknown[] = [];
    const { subject } = migrator({
      identity,
      onSynth: async (workspace) => {
        synthesized.push((await readJson(join(workspace, STATE_PATH))).targets.default);
      },
    });

    const prepared = await subject.prepare(root);
    expect(prepared.plan.ready).toBe(true);
    expect(prepared.plan.checks).toContainEqual({
      name: "credential secrets",
      ok: true,
      message:
        "found the secret ARNs v0 didn't record for compatA-key, compatA-oauth; migrating " +
        "records them in agentcore/.cli/deployed-state.json",
    });
    expect(prepared.plan.changes).toContainEqual({
      path: "agentcore/.cli/deployed-state.json",
      kind: "modified",
    });
    expect(synthesized.map(secretArns)).toEqual([[KEY_SECRET, OAUTH_SECRET]]);
    // Planning leaves the project's deployed state alone.
    expect(await readJson(join(root, STATE_PATH))).toEqual(F1_DEPLOYED_STATE);

    const result = await prepared.apply();
    await prepared.dispose();

    expect(result.migrated).toBe(true);
    const state = await readJson(join(root, STATE_PATH));
    expect(secretArns(state.targets.default)).toEqual([KEY_SECRET, OAUTH_SECRET]);
    expect(state.targets.default.resources.memories).toEqual(
      F1_DEPLOYED_STATE.targets.default.resources.memories,
    );
    expect(identity.calls).toEqual(["compatA-key", "compatA-oauth"]);
  });

  test("only warns when a credential no Gateway target uses has no readable secret ARN", async () => {
    const root = await committedProject();
    const identity = fakeIdentity({
      "compatA-key": new Error(DENIED),
      "compatA-oauth": OAUTH_SECRET,
    });
    const { subject } = migrator({ identity });

    const plan = await subject.plan(root);

    // F1's only Gateway target authenticates with nothing, so neither credential blocks.
    expect(plan.ready).toBe(true);
    expect(plan.checks.find((entry) => entry.name === "credential secrets")?.ok).toBe(true);
    expect(plan.warnings).toContainEqual(
      expect.stringContaining(
        `credential compatA-key, and it couldn't be found: GetApiKeyCredentialProvider failed (${DENIED})`,
      ),
    );
  });

  test("blocks with the credential named when a Gateway target's secret ARN can't be read", async () => {
    const root = await committedProject({ spec: GATEWAY_SPEC });
    const identity = fakeIdentity({
      "compatA-key": KEY_SECRET,
      "compatA-oauth": new Error(DENIED),
    });
    const { subject } = migrator({ identity });

    const plan = await subject.plan(root);

    expect(plan.problems).toEqual([]);
    expect(plan.ready).toBe(false);
    const check = plan.checks.find((entry) => entry.name === "credential secrets");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain(
      `compatA-oauth: GetOauth2CredentialProvider failed (${DENIED})`,
    );
    expect(await readJson(join(root, STATE_PATH))).toEqual(F1_DEPLOYED_STATE);
  });

  test("records every same-account target's secret ARNs, so the v1 app synthesizes all of them", async () => {
    // Both targets in one account, in different regions, with a Gateway authenticating by OAuth.
    const root = await committedProject({ ...twoTargets(), spec: GATEWAY_SPEC });
    const stacks = [
      { name: STACK, target: "default" },
      { name: PROD_STACK, target: "prod" },
    ];
    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });
    const first = migrator({ stacks, identity, onSynth: requireGatewaySecrets });
    const prepared = await first.subject.prepare(root, { target: "default" });
    expect(prepared.plan.ready).toBe(true);
    expect(prepared.plan.checks).toContainEqual(
      expect.objectContaining({
        name: "credential secrets",
        ok: true,
        message: expect.stringContaining("compatA-oauth (target prod)"),
      }),
    );
    await prepared.apply();
    await prepared.dispose();

    const written = await readJson(join(root, STATE_PATH));
    expect(secretArns(written.targets.default)).toEqual([KEY_SECRET, OAUTH_SECRET]);
    expect(secretArns(written.targets.prod)).toEqual([KEY_SECRET, OAUTH_SECRET]);

    // The pending run finds every ARN recorded, so it synthesizes without looking any up.
    const calls = identity.calls.length;
    const rerun = migrator({
      stacks,
      sharedCloudFormation: first.cloudFormation,
      identity,
      onSynth: requireGatewaySecrets,
    });
    const finishing = await rerun.subject.prepare(root, { target: "prod" });
    expect(finishing.plan.finishPending).toBe(true);
    expect(finishing.plan.ready).toBe(true);
    expect(finishing.plan.changes).toEqual([]);
    expect(identity.calls).toHaveLength(calls);
    await finishing.apply();
    await finishing.dispose();
  });

  test("the pending run records the secret ARNs for its synth, without writing the project", async () => {
    const root = await committedProject({ ...twoTargets(), spec: GATEWAY_SPEC });
    const stacks = [
      { name: STACK, target: "default" },
      { name: PROD_STACK, target: "prod" },
    ];
    // The first run has no Identity client, as a CLI from before the fix would, so it records none.
    const first = migrator({ stacks });
    const prepared = await first.subject.prepare(root, { target: "default" });
    await prepared.apply();
    await prepared.dispose();

    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });
    const rerun = migrator({
      stacks,
      sharedCloudFormation: first.cloudFormation,
      identity,
      onSynth: requireGatewaySecrets,
    });
    const finishing = await rerun.subject.prepare(root, { target: "prod" });
    expect(finishing.plan.ready).toBe(true);
    expect(finishing.plan.changes).toEqual([]);
    await finishing.dispose();
    expect(secretArns((await readJson(join(root, STATE_PATH))).targets.prod)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("blocks when a target in another account has a Gateway credential without its secret ARN", async () => {
    const files = twoTargets();
    const root = await committedProject({
      ...files,
      spec: GATEWAY_SPEC,
      targets: [
        { name: "default", account: "998846730471", region: "us-east-1" },
        { name: "prod", account: "111111111111", region: "us-west-2" },
      ],
    });
    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });
    const { subject } = migrator({ identity, onSynth: requireGatewaySecrets });

    const plan = await subject.plan(root, { target: "default" });

    expect(plan.ready).toBe(false);
    const check = plan.checks.find((entry) => entry.name === "credential secrets");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain(
      "Target prod is in account 111111111111 (us-west-2), but the active credentials are for " +
        "account 998846730471. v1's CDK app synthesizes every target's stack, so it needs the " +
        "secret ARNs of compatA-oauth there too",
    );
  });

  test("a target in another account with every secret ARN recorded doesn't block", async () => {
    const files = twoTargets();
    const state = files.deployedState as typeof F1_DEPLOYED_STATE & {
      targets: { prod: typeof F1_DEPLOYED_STATE.targets.default };
    };
    const credentials = state.targets.prod.resources.credentials;
    const root = await committedProject({
      ...files,
      spec: GATEWAY_SPEC,
      targets: [
        { name: "default", account: "998846730471", region: "us-east-1" },
        { name: "prod", account: "111111111111", region: "us-west-2" },
      ],
      deployedState: {
        targets: {
          default: state.targets.default,
          prod: {
            resources: {
              ...state.targets.prod.resources,
              credentials: {
                "compatA-key": { ...credentials["compatA-key"], clientSecretArn: KEY_SECRET },
                "compatA-oauth": { ...credentials["compatA-oauth"], clientSecretArn: OAUTH_SECRET },
              },
            },
          },
        },
      },
    });
    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });
    const { subject } = migrator({ identity, onSynth: requireGatewaySecrets });

    const plan = await subject.plan(root, { target: "default" });

    expect(plan.ready).toBe(true);
    expect(plan.checks.every((check) => check.ok)).toBe(true);
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
