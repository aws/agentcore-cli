import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserCancellationError } from "../../../errors/errors";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import type { DeployBackendInput, ProjectBackend } from "../../../core/project";
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
      return result;
    },
    async resolveDeployedResources() {
      return [];
    },
  };
  return { calls, confirmations, backend };
}

type TestDeployOptions = {
  isTTY?: boolean;
  stdin?: string;
  teardown?: TeardownConfirmationRequest;
  resolveAccount?: (region: string) => Promise<string>;
};

function testDeployCommand(
  result: DeployResult,
  events: ProjectEvent[] = [],
  options: TestDeployOptions = {},
) {
  const io = testIO({ isTTY: options.isTTY, stdin: options.stdin });
  const fake = fakeBackend(result, events, options.teardown);
  const core = new TestCoreClient({
    backends: { CDK: fake.backend },
    resolveAccount: options.resolveAccount,
  });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });

  return {
    ...fake,
    io,
    run: (args: string[] = []) => root.route(["node", "agentcore", "project", "deploy", ...args]),
    create: (args: string[]) => root.route(["node", "agentcore", "project", ...args]),
  };
}

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-deploy-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project whose aws-targets.json holds exactly `contents`, and cds into it. */
async function inProjectWithTargets(
  subject: ReturnType<typeof testDeployCommand>,
  contents: string = JSON.stringify(TARGETS),
): Promise<string> {
  const directory = await inTempDirectory();
  await subject.create(["create", "--name", "orders", "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, "orders");
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), contents);
  process.chdir(projectRoot);
  return projectRoot;
}

/**
 * Rewrites the spec so it declares no resources — what remove --all leaves —
 * which is the up-front signal the deploy handler prompts for a teardown on.
 */
async function emptyProjectSpec(projectRoot: string): Promise<void> {
  await writeFile(
    join(projectRoot, "agentcore", "agentcore.json"),
    JSON.stringify({ name: "orders", version: 1 }),
  );
}

describe("project deploy handler", () => {
  test("defaults to the default target and keeps progress off stdout", async () => {
    const subject = testDeployCommand(
      { outputs: { ZetaUrl: "https://zeta.example", AlphaArn: "arn:alpha" } },
      [
        { type: "step", message: "Preparing deployment" },
        { type: "output", line: "CREATE_IN_PROGRESS | AWS::IAM::Role" },
        { type: "step", message: "Deploying stack" },
      ],
    );
    await inProjectWithTargets(subject);

    await subject.run();

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual(DEFAULT_TARGET);
    expect(subject.io.stderr()).toContain("Preparing deployment\nDeploying stack");
    // Output lines belong to the debug log outside a TTY, not the plain stream.
    expect(subject.io.stderr()).not.toContain("CREATE_IN_PROGRESS");
    expect(subject.io.stderr()).toContain("Deployed project 'orders' to target 'default'");
    // Stack outputs are rendered only with --json; without it stdout stays empty.
    expect(subject.io.stdout()).toBe("");
  });

  test("passes an explicit target and renders the result as JSON", async () => {
    const result = { outputs: { ServiceUrl: "https://service.example" } };
    const subject = testDeployCommand(result);
    await inProjectWithTargets(subject);

    await subject.run(["--target", "staging", "--json"]);

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual(STAGING_TARGET);
    expect(JSON.parse(subject.io.stdout())).toEqual(result);
  });

  // --yes is the only way to authorize the teardown the backend refuses without
  // it, so a flag that never reaches the backend would make it unreachable.
  test("carries --yes through as permission to tear the stack down", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets(subject);

    await subject.run(["--yes"]);

    expect(subject.confirmations).toEqual([true]);
    expect(subject.io.stderr()).not.toContain("(y/N)");
  });

  // The prompt is settled before the deploy generator starts (and before any
  // progress UI could own the terminal), so it fires on the spec declaring
  // nothing deployable rather than on the backend's post-synth discovery.
  test("prompts before tearing down and proceeds on yes", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets(subject);
    await emptyProjectSpec(projectRoot);

    await subject.run();

    expect(subject.io.stderr()).toContain("Project 'orders' declares no resources to deploy.");
    expect(subject.io.stderr()).toContain(TEARDOWN_PROMPT);
    expect(subject.confirmations).toEqual([true]);
    expect(subject.io.stderr()).toContain("Removed project 'orders' from target 'default'");
  });

  test.each([
    ["no", "n\n"],
    ["the default", "\n"],
  ])("does not tear down when the user chooses %s", async (_label, stdin) => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin,
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets(subject);
    await emptyProjectSpec(projectRoot);

    await expect(subject.run()).rejects.toBeInstanceOf(UserCancellationError);

    expect(subject.io.stderr()).toContain("(y/N)");
    // Declined before the generator started: the backend never ran.
    expect(subject.calls).toEqual([]);
    expect(subject.io.stderr()).not.toContain("Removed project");
  });

  test("cancels when interactive input closes without an answer", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "",
      teardown: TEARDOWN,
    });
    const projectRoot = await inProjectWithTargets(subject);
    await emptyProjectSpec(projectRoot);

    await expect(subject.run()).rejects.toBeInstanceOf(UserCancellationError);

    expect(subject.calls).toEqual([]);
    expect(subject.io.stderr()).not.toContain("Removed project");
  });

  // The spec-level check can miss (a hand-edited CDK app can synthesize an
  // empty template from a non-empty spec); the backend's post-synth count is
  // the backstop, and by then the answer must already be no.
  test("falls back to requiring --yes when only synthesis reveals the teardown", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets(subject);

    await expect(subject.run()).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
  });

  test("requires --yes instead of prompting in a non-interactive shell", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets(subject);

    await expect(subject.run()).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
  });

  test("requires --yes instead of prompting in JSON mode", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [], {
      isTTY: true,
      stdin: "yes\n",
      teardown: TEARDOWN,
    });
    await inProjectWithTargets(subject);

    await expect(subject.run(["--json"])).rejects.toThrow(/--yes/);

    expect(subject.io.stderr()).not.toContain("(y/N)");
    expect(subject.confirmations).toEqual([false]);
  });

  test("does not prompt for a normal deployment", async () => {
    const subject = testDeployCommand({ outputs: { RuntimeArn: "arn:runtime" } }, [], {
      isTTY: true,
      stdin: "yes\n",
    });
    await inProjectWithTargets(subject);

    await subject.run();

    expect(subject.io.stderr()).not.toContain("(y/N)");
  });

  test("says the project was removed when the deploy tore the stack down", async () => {
    const subject = testDeployCommand({ outputs: {}, tornDown: true }, [
      { type: "step", message: "Removing stack AgentCore-orders-default" },
    ]);
    await inProjectWithTargets(subject);

    await subject.run(["--yes"]);

    expect(subject.io.stderr()).toContain("Removing stack AgentCore-orders-default");
    expect(subject.io.stderr()).toContain("Removed project 'orders' from target 'default'");
    // "Deployed" would be the wrong word for a stack that no longer exists.
    expect(subject.io.stderr()).not.toContain("Deployed project");
  });

  test("rejects an unknown target without invoking the backend", async () => {
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(subject);

    await expect(subject.run(["--target", "nope"])).rejects.toThrow(
      /no deployment target named 'nope'/,
    );
    expect(subject.calls).toEqual([]);
  });

  test("requires deployment targets to be configured for a named target", async () => {
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(subject, JSON.stringify([]));

    await expect(subject.run(["--target", "staging"])).rejects.toThrow(
      /No deployment targets are configured/,
    );
    expect(subject.calls).toEqual([]);
  });

  // The zero-configuration path: a fresh project's aws-targets.json is [], so
  // the first deploy must invent the default target rather than demand edits.
  test("creates the default target from the environment on first deploy", async () => {
    const subject = testDeployCommand({ outputs: { RuntimeArn: "arn:runtime" } });
    const projectRoot = await inProjectWithTargets(subject, JSON.stringify([]));

    await subject.run(["--region", "us-west-2"]);

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual({
      name: "default",
      account: "111122223333",
      region: "us-west-2",
    });
    expect(subject.io.stderr()).toContain(
      "Created default deployment target: account 111122223333, region us-west-2",
    );
    expect(subject.io.stderr()).toContain("Deployed project 'orders' to target 'default'");
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).json()).toEqual([
      { name: "default", account: "111122223333", region: "us-west-2" },
    ]);
  });

  test("rejects an unsupported region instead of writing an invalid target", async () => {
    const subject = testDeployCommand({ outputs: {} });
    const projectRoot = await inProjectWithTargets(subject, JSON.stringify([]));

    const message = await messageFrom(subject.run(["--region", "us-west-1"]));

    expect(message).toContain("'us-west-1' is not an AgentCore-supported region");
    expect(message).toContain("us-east-1");
    expect(subject.calls).toEqual([]);
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).text()).toBe("[]");
  });

  test("explains how to fix unresolvable credentials", async () => {
    const subject = testDeployCommand({ outputs: {} }, [], {
      resolveAccount: async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });
    await inProjectWithTargets(subject, JSON.stringify([]));

    const message = await messageFrom(subject.run(["--region", "us-east-1"]));

    expect(message).toContain("Could not load credentials from any providers");
    expect(message).toContain("aws configure");
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
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(
      subject,
      JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-11" }]),
    );

    const message = await messageFrom(subject.run());

    expect(message).toContain("aws-targets.json");
    expect(message).toContain("at [0].region");
    expect(message).toContain('"us-east-1"');
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the duplicate target name", async () => {
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(subject, JSON.stringify([DEFAULT_TARGET, DEFAULT_TARGET]));

    await expect(subject.run()).rejects.toThrow(/Duplicate deployment target name: default/);
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the account id rule", async () => {
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(
      subject,
      JSON.stringify([{ name: "default", account: "123", region: "us-east-1" }]),
    );

    await expect(subject.run()).rejects.toThrow(/AWS account ID must be exactly 12 digits/);
    expect(subject.calls).toEqual([]);
  });

  test("surfaces the parse error for malformed json", async () => {
    const subject = testDeployCommand({ outputs: {} });
    await inProjectWithTargets(subject, '[{ "name": "default", }]');

    await expect(subject.run()).rejects.toThrow(/JSON Parse error/);
    expect(subject.calls).toEqual([]);
  });
});
