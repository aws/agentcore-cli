import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserCancellationError } from "../../../errors/errors";
import { createRootHandler } from "../../index";
import { DEFAULT_GLOBAL_CONFIG } from "../../../globalConfig";
import { ValueContext } from "../../../router";
import {
  assertMetricEmitted,
  createSilentLogger,
  getTestTelemetryClient,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  withTelemetry,
} from "../../../testing";
import type { DeployBackendInput, ProjectBackend } from "../../../core/project";
import type { V0DeployInput, V0DeployRunner } from "../../../core/project/legacy/deploy";
import { writeMigrationState } from "../../../core/project/migrate/journal";
import { ProjectStateError } from "../../../errors";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { DeployResult, Project, ProjectEvent, TeardownConfirmationRequest } from "../types";

const DEFAULT_TARGET: AwsDeploymentTarget = {
  name: "default",
  account: "111122223333",
  region: "us-east-1",
};
const STAGING_TARGET: AwsDeploymentTarget = {
  name: "staging",
  account: "444455556666",
  region: "eu-west-1",
};
const TARGETS = [DEFAULT_TARGET, STAGING_TARGET];
const TEARDOWN: TeardownConfirmationRequest = {
  projectName: "orders",
  targetName: "default",
  resourceDescription: "stack 'AgentCore-orders-default-0' and every resource in it",
  account: DEFAULT_TARGET.account,
  region: DEFAULT_TARGET.region,
};
const TEARDOWN_PROMPT =
  "Deploying will delete everything deployed to target 'default' (111122223333/us-east-1). " +
  "Continue? (y/N)";

/**
 * A ProjectBackend that deploys successfully, which CdkBackend cannot do until
 * CDK deployment is implemented. Stubbing the backend rather than the whole
 * manager keeps the real FsProjectManager in the path, so target resolution and
 * withProject run for real.
 */
function fakeBackend(
  result: DeployResult,
  events: ProjectEvent[] = [],
  teardown?: TeardownConfirmationRequest,
  failure?: Error,
) {
  const calls: { project: Project; input: DeployBackendInput }[] = [];
  const confirmations: boolean[] = [];
  const backend: ProjectBackend = {
    async *build() {},
    async *deploy(project, input) {
      calls.push({ project, input });
      if (teardown) {
        const confirmed = await input.confirmTeardown(teardown);
        confirmations.push(confirmed);
        if (!confirmed) {
          throw new Error("Re-run with --yes to confirm the teardown.");
        }
      }
      yield* events;
      if (failure) throw failure;
      return result;
    },
    async resolveDeployedResources() {
      return [];
    },
    async resolveProjectResources() {
      return [];
    },
  };
  return { calls, confirmations, backend };
}

type TestDeployOptions = {
  isTTY?: boolean;
  stdin?: string;
  teardown?: TeardownConfirmationRequest;
  /** Thrown by the fake backend after its events, to exercise failure paths. */
  failure?: Error;
  resolveAccount?: (region: string) => Promise<string>;
  /** Seeds the global config's transactionSearch flag (defaults to on). */
  transactionSearch?: boolean;
  runV0Deploy?: V0DeployRunner;
};

async function testDeployCommand(
  result: DeployResult,
  events: ProjectEvent[] = [],
  options: TestDeployOptions = {},
) {
  const io = testIO({ isTTY: options.isTTY, stdin: options.stdin });
  const fake = fakeBackend(result, events, options.teardown, options.failure);
  const core = new TestCoreClient({
    backends: { CDK: fake.backend },
    resolveAccount: options.resolveAccount,
  });
  const logger = createSilentLogger();
  const globalConfigAccessor = new TestGlobalConfigAccessor(
    options.transactionSearch === undefined
      ? undefined
      : {
          initialConfigData: {
            ...DEFAULT_GLOBAL_CONFIG,
            transactionSearch: options.transactionSearch,
          },
        },
  );
  const { client, filePath, cleanup } = await getTestTelemetryClient();
  cleanups.push(cleanup);
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor,
    logger,
    runV0Deploy: options.runV0Deploy,
  });

  return {
    ...fake,
    io,
    telemetryFilePath: filePath,
    run: async (args: string[] = []) =>
      withTelemetry(ValueContext.EmptyContext(), client, (ctx) =>
        root.route(["node", "agentcore", "deploy", ...args], ctx),
      ),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

/** Scaffolds a project whose aws-targets.json holds exactly `contents`, and cds into it. */
async function inProjectWithTargets(contents: string = JSON.stringify(TARGETS)): Promise<string> {
  const { projectRoot, cleanup } = await initProject({
    name: "orders",
    flags: ["--template", "agent-python-minimal"],
  });
  cleanups.push(cleanup);
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), contents);
  return projectRoot;
}

/**
 * Rewrites the spec so it declares no resources — what remove --all leaves —
 * which is the up-front signal the deploy handler prompts for a teardown on.
 */
async function emptyProjectSpec(projectRoot: string): Promise<void> {
  await writeFile(
    join(projectRoot, "agentcore", "agentcore.json"),
    JSON.stringify({ name: "orders", version: 2 }),
  );
}

/** Records a pending migration of `pending` (or one stopped while writing files). */
async function pendingMigration(
  projectRoot: string,
  pending: AwsDeploymentTarget[],
  filesStatus: "writing" | "installed" = "installed",
): Promise<void> {
  await writeMigrationState(projectRoot, {
    version: 2,
    startedAt: "2026-10-13T00:00:00.000Z",
    files: { status: filesStatus, backup: "agentcore/.cli/migrate-backup", changes: [] },
    refactored: [],
    targets: pending.map((target) => ({
      name: target.name,
      account: target.account,
      region: target.region,
      stackName: `AgentCore-orders-${target.name}`,
      status: "pending" as const,
    })),
  });
}

describe("project deploy handler, with a pending migration", () => {
  test("refuses a target the migration hasn't finished, naming its account and region", async () => {
    const projectRoot = await inProjectWithTargets();
    await pendingMigration(projectRoot, [STAGING_TARGET]);
    const subject = await testDeployCommand({ outputs: {} });

    const error = await subject.run(["--target", "staging", "--yes"]).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProjectStateError);
    expect(error.message).toBe(
      "Target 'staging' (AWS account 444455556666, eu-west-1) hasn't been migrated yet: its " +
        "stack AgentCore-orders-staging still has the v0 logical IDs, so a v1 deploy would " +
        "replace its resources. Run `agentcore migrate --target staging` with credentials for " +
        "account 444455556666, then deploy.",
    );
    expect(subject.calls).toEqual([]);
  });

  test("still deploys a target the migration finished", async () => {
    const projectRoot = await inProjectWithTargets();
    await pendingMigration(projectRoot, [STAGING_TARGET]);
    const subject = await testDeployCommand({ outputs: {} });

    await subject.run(["--target", "default", "--yes"]);

    expect(subject.calls.map((call) => call.input.target.name)).toEqual(["default"]);
  });

  test("refuses a v0 deploy while a migration stopped writing the project files", async () => {
    const projectRoot = await inProjectWithTargets();
    await writeFile(
      join(projectRoot, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "orders", version: 1 }),
    );
    await pendingMigration(projectRoot, [DEFAULT_TARGET], "writing");
    const legacyDeploys: V0DeployInput[] = [];
    const subject = await testDeployCommand({ outputs: {} }, [], {
      runV0Deploy: async (input) => {
        legacyDeploys.push(input);
        return 0;
      },
    });

    await expect(subject.run(["--yes"])).rejects.toThrow("stopped while writing the project files");
    expect(legacyDeploys).toEqual([]);
  });
});

describe("project deploy handler", () => {
  test.each(["--yes", "--json"])(
    "delegates a legacy deploy with %s before resolving an account or using v1 CDK",
    async (flag) => {
      const projectRoot = await inProjectWithTargets("[]");
      const specPath = join(projectRoot, "agentcore", "agentcore.json");
      const manifestPath = join(projectRoot, "agentcore", "cdk", "package.json");
      await writeFile(specPath, JSON.stringify({ name: "orders", version: 1 }));
      await writeFile(
        manifestPath,
        JSON.stringify({ dependencies: { "@aws/agentcore-cdk": "^0.1.0-alpha.19" } }),
      );
      const before = await Promise.all([
        readFile(specPath, "utf8"),
        readFile(manifestPath, "utf8"),
      ]);
      const accountCalls: string[] = [];
      const legacyDeploys: V0DeployInput[] = [];
      const subject = await testDeployCommand({ outputs: {} }, [], {
        resolveAccount: async (region) => {
          accountCalls.push(region);
          return DEFAULT_TARGET.account;
        },
        runV0Deploy: async (input) => {
          legacyDeploys.push(input);
          return 0;
        },
      });

      await subject.run(["--region", "eu-west-2", flag]);

      expect(subject.calls).toEqual([]);
      expect(accountCalls).toEqual([]);
      expect(legacyDeploys).toEqual([
        {
          projectRoot,
          target: "default",
          yes: flag === "--yes",
          json: flag === "--json",
        },
      ]);
      expect(subject.io.stdout()).toBe("");
      const regionWarning =
        "--region is ignored for v0 projects; v0 uses the target's region from " +
        "aws-targets.json, or AWS_REGION / your AWS profile.";
      expect(subject.io.stderr()).toBe(
        flag === "--json"
          ? regionWarning
          : `${regionWarning}\n` +
              "This is a v0 project; running the latest v0 AgentCore CLI deploy in compatibility mode.",
      );
      expect(
        await Promise.all([readFile(specPath, "utf8"), readFile(manifestPath, "utf8")]),
      ).toEqual(before);
    },
  );

  test("does not warn about --region when it was never passed", async () => {
    const projectRoot = await inProjectWithTargets("[]");
    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const manifestPath = join(projectRoot, "agentcore", "cdk", "package.json");
    await writeFile(specPath, JSON.stringify({ name: "orders", version: 1 }));
    await writeFile(
      manifestPath,
      JSON.stringify({ dependencies: { "@aws/agentcore-cdk": "^0.1.0-alpha.19" } }),
    );
    const legacyDeploys: V0DeployInput[] = [];
    const subject = await testDeployCommand({ outputs: {} }, [], {
      runV0Deploy: async (input) => {
        legacyDeploys.push(input);
        return 0;
      },
    });

    await subject.run(["--yes"]);

    expect(legacyDeploys).toHaveLength(1);
    expect(subject.io.stderr()).toBe(
      "This is a v0 project; running the latest v0 AgentCore CLI deploy in compatibility mode.",
    );
  });

  test("preserves the v0 deployer's non-zero exit code", async () => {
    await inProjectWithTargets();
    await writeFile(
      join(process.cwd(), "agentcore", "agentcore.json"),
      JSON.stringify({ name: "orders", version: 1 }),
    );
    const subject = await testDeployCommand({ outputs: {} }, [], { runV0Deploy: async () => 7 });

    await expect(subject.run(["--yes"])).rejects.toMatchObject({ exitCode: 7 });
    expect(subject.calls).toEqual([]);
  });

  test("defaults to the default target and keeps progress off stdout", async () => {
    const subject = await testDeployCommand(
      { outputs: { ZetaUrl: "https://zeta.example", AlphaArn: "arn:alpha" } },
      [
        { type: "step", message: "Preparing deployment" },
        { type: "output", line: "CREATE_IN_PROGRESS | AWS::IAM::Role" },
        { type: "step", message: "Deploying stack" },
      ],
    );
    await inProjectWithTargets();

    await subject.run();

    await assertMetricEmitted(subject.telemetryFilePath, "cli.command_run", {
      command_path: "/agentcore/deploy",
      exit_reason: "success",
      project_runtime_count: 1,
      project_memory_count: 0,
      project_gateway_count: 0,
      project_harness_count: 0,
    });
    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual(DEFAULT_TARGET);
    expect(subject.io.stderr()).toContain("Preparing deployment\nDeploying stack");
    // Output lines belong to the debug log outside a TTY, not the plain stream.
    expect(subject.io.stderr()).not.toContain("CREATE_IN_PROGRESS");
    expect(subject.io.stderr()).toContain("deployed project 'orders' to target 'default'");
    expect(subject.io.stderr()).toContain("next step:\n  agentcore invoke");
    // Stack outputs are rendered only with --json; without it stdout stays empty.
    expect(subject.io.stdout()).toBe("");
  });

  test("passes the global config's transactionSearch flag into the deploy", async () => {
    const enabled = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets();
    await enabled.run();
    expect(enabled.calls[0]?.input.transactionSearch).toBe(true);

    const disabled = await testDeployCommand({ outputs: {} }, [], { transactionSearch: false });
    await inProjectWithTargets();
    await disabled.run();
    expect(disabled.calls[0]?.input.transactionSearch).toBe(false);
  });

  test("passes an explicit target and renders the result as JSON", async () => {
    const result = { outputs: { ServiceUrl: "https://service.example" } };
    const subject = await testDeployCommand(result);
    await inProjectWithTargets();

    await subject.run(["--target", "staging", "--json"]);

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual(STAGING_TARGET);
    expect(JSON.parse(subject.io.stdout())).toEqual({
      message: "deployed project 'orders' to target 'staging'",
      ...result,
    });
    expect(subject.io.stderr()).not.toContain("Next step");
  });

  test("renders a teardown result as JSON with the removal message", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true });
    await inProjectWithTargets();

    await subject.run(["--yes", "--json"]);

    expect(JSON.parse(subject.io.stdout())).toEqual({
      message: "removed project 'orders' from target 'default'",
      outputs: {},
      tornDown: true,
    });
  });

  test("renders a deploy failure as JSON without changing the thrown error", async () => {
    const subject = await testDeployCommand({ outputs: {} }, [], {
      failure: new Error("The stack failed creation: ROLLBACK_COMPLETE"),
    });
    await inProjectWithTargets();

    await expect(subject.run(["--json"])).rejects.toThrow("ROLLBACK_COMPLETE");

    await assertMetricEmitted(subject.telemetryFilePath, "cli.command_run", {
      command_path: "/agentcore/deploy",
      exit_reason: "failure",
      project_runtime_count: 1,
      project_harness_count: 0,
    });
    expect(JSON.parse(subject.io.stdout())).toEqual({
      error: "The stack failed creation: ROLLBACK_COMPLETE",
    });
  });

  // --yes is the only way to authorize the teardown the backend refuses without
  // it, so a flag that never reaches the backend would make it unreachable.
  test("carries --yes through as permission to tear the stack down", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets();

    await subject.run(["--yes"]);

    expect(subject.confirmations).toEqual([true]);
    expect(subject.io.stderr()).not.toContain("(y/N)");
  });

  // The prompt is settled before the deploy generator starts (and before any
  // progress UI could own the terminal), so it fires on the spec declaring
  // nothing deployable rather than on the backend's post-synth discovery.
  test("prompts before tearing down and proceeds on yes", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets();
    await emptyProjectSpec(projectRoot);

    await subject.run();

    await assertMetricEmitted(subject.telemetryFilePath, "cli.command_run", {
      command_path: "/agentcore/deploy",
      exit_reason: "success",
      project_runtime_count: 0,
      project_memory_count: 0,
      project_gateway_count: 0,
      project_harness_count: 0,
      project_tool_runtime_count: 0,
      project_payment_manager_count: 0,
    });
    expect(subject.io.stderr()).toContain("Project 'orders' declares no resources to deploy.");
    expect(subject.io.stderr()).toContain(TEARDOWN_PROMPT);
    expect(subject.confirmations).toEqual([true]);
    expect(subject.io.stderr()).toContain("removed project 'orders' from target 'default'");
  });

  test.each([
    ["no", "n\n"],
    ["the default", "\n"],
  ])("does not tear down when the user chooses %s", async (_label, stdin) => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin,
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets();
    await emptyProjectSpec(projectRoot);

    await expect(subject.run()).rejects.toBeInstanceOf(UserCancellationError);

    await assertMetricEmitted(subject.telemetryFilePath, "cli.command_run", {
      command_path: "/agentcore/deploy",
      exit_reason: "failure",
      project_harness_count: 0,
    });
    expect(subject.io.stderr()).toContain("(y/N)");
    // Declined before the generator started: the backend never ran.
    expect(subject.calls).toEqual([]);
    expect(subject.io.stderr()).not.toContain("removed project");
  });

  test("cancels when interactive input closes without an answer", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "",
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets();
    await emptyProjectSpec(projectRoot);

    await expect(subject.run()).rejects.toBeInstanceOf(UserCancellationError);

    await assertMetricEmitted(subject.telemetryFilePath, "cli.command_run", {
      command_path: "/agentcore/deploy",
      exit_reason: "failure",
      project_harness_count: 0,
    });
    expect(subject.calls).toEqual([]);
    expect(subject.io.stderr()).not.toContain("removed project");
  });

  // The spec-level check can miss (a hand-edited CDK app can synthesize an
  // empty template from a non-empty spec); the backend's post-synth count is
  // the backstop, and by then the answer must already be no.
  test("falls back to requiring --yes when only synthesis reveals the teardown", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets();

    await expect(subject.run()).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
  });

  test("requires --yes instead of prompting in a non-interactive shell", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets();

    await expect(subject.run()).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
  });

  test("requires --yes instead of prompting in JSON mode", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets();

    await expect(subject.run(["--json"])).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
    // JSON mode reports the refusal on stdout too, so scripts need not parse stderr.
    expect(JSON.parse(subject.io.stdout())).toEqual({
      error: expect.stringContaining("--yes"),
    });
  });

  test("does not prompt for a normal deployment", async () => {
    const subject = await testDeployCommand({ outputs: { RuntimeArn: "arn:runtime" } }, [], {
      isTTY: true,
      stdin: "yes\n",
    });
    await inProjectWithTargets();

    await subject.run();

    expect(subject.io.stderr()).not.toContain("(y/N)");
  });

  test("says the project was removed when the deploy tore the stack down", async () => {
    const subject = await testDeployCommand({ outputs: {}, tornDown: true }, [
      { type: "step", message: "removing stack AgentCore-orders-default" },
    ]);
    await inProjectWithTargets();

    await subject.run(["--yes"]);

    expect(subject.io.stderr()).toContain("removing stack AgentCore-orders-default");
    expect(subject.io.stderr()).toContain("removed project 'orders' from target 'default'");
    // "Deployed" would be the wrong word for a stack that no longer exists.
    expect(subject.io.stderr()).not.toContain("deployed project");
    // There is nothing left to invoke.
    expect(subject.io.stderr()).not.toContain("agentcore invoke");
  });

  test("rejects an unknown target without invoking the backend", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets();

    await expect(subject.run(["--target", "nope"])).rejects.toThrow(
      /no deployment target named 'nope'/,
    );
    expect(subject.calls).toEqual([]);
  });

  test("requires deployment targets to be configured for a named target", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets(JSON.stringify([]));

    await expect(subject.run(["--target", "staging"])).rejects.toThrow(
      /No deployment targets are configured/,
    );
    expect(subject.calls).toEqual([]);
  });

  // The zero-configuration path: a fresh project's aws-targets.json is [], so
  // the first deploy must invent the default target rather than demand edits.
  test("creates the default target from the environment on first deploy", async () => {
    const subject = await testDeployCommand({ outputs: { RuntimeArn: "arn:runtime" } });
    const projectRoot = await inProjectWithTargets(JSON.stringify([]));

    await subject.run(["--region", "us-west-2"]);

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual({
      name: "default",
      account: "111122223333",
      region: "us-west-2",
    });
    expect(subject.io.stderr()).toContain(
      "created default deployment target: account 111122223333, region us-west-2",
    );
    expect(subject.io.stderr()).toContain("deployed project 'orders' to target 'default'");
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).json()).toEqual([
      { name: "default", account: "111122223333", region: "us-west-2" },
    ]);
  });

  test("rejects an unsupported region instead of writing an invalid target", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    const projectRoot = await inProjectWithTargets(JSON.stringify([]));

    const message = await messageFrom(subject.run(["--region", "af-south-1"]));

    expect(message).toContain("'af-south-1' is not an AgentCore-supported region");
    expect(message).toContain("us-east-1");
    expect(subject.calls).toEqual([]);
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).text()).toBe("[]");
  });

  test("explains how to fix unresolvable credentials", async () => {
    const subject = await testDeployCommand({ outputs: {} }, [], {
      resolveAccount: async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });
    await inProjectWithTargets(JSON.stringify([]));

    const message = await messageFrom(subject.run(["--region", "us-east-1"]));

    expect(message).toContain("Could not load credentials from any providers");
    expect(message).toContain("aws login");
    expect(subject.calls).toEqual([]);
  });
});

/** The message the user would see on stderr, since the reporter prints only that. */
async function messageFrom(command: Promise<void>): Promise<string> {
  try {
    await command;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the command to fail");
}

describe("project deploy reports which field of aws-targets.json is wrong", () => {
  test("names the offending field for an unsupported region", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets(
      JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-11" }]),
    );

    const message = await messageFrom(subject.run());

    expect(message).toContain("aws-targets.json");
    expect(message).toContain("at [0].region");
    expect(message).toContain('"us-east-1"');
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the duplicate target name", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets(JSON.stringify([DEFAULT_TARGET, DEFAULT_TARGET]));

    await expect(subject.run()).rejects.toThrow(
      /Duplicate deployment target name \(ignoring case\): default/,
    );
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the account id rule", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets(
      JSON.stringify([{ name: "default", account: "123", region: "us-east-1" }]),
    );

    await expect(subject.run()).rejects.toThrow(/AWS account ID must be exactly 12 digits/);
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the parse error for malformed json", async () => {
    const subject = await testDeployCommand({ outputs: {} });
    await inProjectWithTargets('[{ "name": "default", }]');

    await expect(subject.run()).rejects.toThrow(/JSON Parse error/);
    expect(subject.calls).toEqual([]);
  });
});
