import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRootHandler } from "../../index";
import { ValueContext, type Context } from "../../../router";
import {
  assertMetricEmitted,
  createSilentLogger,
  getTestTelemetryClient,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  TestIdentityClient,
  testIO,
  ttyTestIO,
  waitFor,
  withTelemetry,
} from "../../../testing";
import { CdkBackend, type ProjectBackend } from "../../../core/project";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { ResolvedProjectResource } from "../types";

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
const ARN = `arn:aws:bedrock-agentcore:${DEFAULT_TARGET.region}:${DEFAULT_TARGET.account}`;

function fakeBackend(deployed: ResolvedProjectResource[]) {
  const targets: AwsDeploymentTarget[] = [];
  const backend: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield { type: "step", message: "unused by these tests" };
      return { outputs: {} };
    },
    async resolveDeployedResources() {
      throw new Error("project status resolves project resources, not deployed resources");
    },
    async resolveProjectResources(_project, input) {
      targets.push(input.target);
      return deployed;
    },
  };
  return { targets, backend };
}

// The identity every target-account test expects: TestCoreClient's stubbed STS
// lookup returns DEFAULT_TARGET's account, and no AWS_PROFILE is set.
const DEFAULT_IDENTITY = {
  credentialSource: "profile",
  profile: "default",
  success: true,
  account: DEFAULT_TARGET.account,
};

type ResolveAccount = (region: string) => Promise<string>;

function statusCommand(backend: ProjectBackend, io = testIO(), resolveAccount?: ResolveAccount) {
  const root = createRootHandler(
    new TestCoreClient({ backends: { CDK: backend }, resolveAccount }),
    {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    },
  );

  return {
    io,
    json: () => JSON.parse(io.stdout()),
    run: (args: string[] = [], ctx?: Context) =>
      root.route(["node", "agentcore", "status", ...args], ctx),
  };
}

function testStatusCommand(
  deployed: ResolvedProjectResource[] = [],
  io = testIO(),
  resolveAccount?: ResolveAccount,
) {
  const fake = fakeBackend(deployed);
  return { ...fake, ...statusCommand(fake.backend, io, resolveAccount) };
}

// The credential environment the identity lookup reads, cleared for every test
// so a developer's own AWS_PROFILE or keys never leak into the assertions.
const CREDENTIAL_ENV = ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of CREDENTIAL_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function inProject(
  spec: Record<string, unknown> = {},
  targets: AwsDeploymentTarget[] = TARGETS,
): Promise<string> {
  const { projectRoot, cleanup } = await initProject({ name: "orders" });
  cleanups.push(cleanup);
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  const specPath = join(projectRoot, "agentcore", "agentcore.json");
  const current = JSON.parse(await Bun.file(specPath).text());
  await writeFile(specPath, JSON.stringify({ ...current, ...spec }));
  return projectRoot;
}

const deployed = (
  resourceType: ResolvedProjectResource["resourceType"],
  name: string,
  identifier: { arn: string } | { id: string },
  children?: ResolvedProjectResource[],
): ResolvedProjectResource => ({
  resourceType,
  name,
  ...(children ? { children } : {}),
  deploymentState: "deployed",
  ...identifier,
});

const localOnly = (
  resourceType: ResolvedProjectResource["resourceType"],
  name: string,
  children?: ResolvedProjectResource[],
): ResolvedProjectResource => ({
  resourceType,
  name,
  ...(children ? { children } : {}),
  deploymentState: "local-only",
});

const HARNESS_ROW = localOnly("harness", "orders");

const memory = (name: string) => ({ name, eventExpiryDuration: 30 });
const policy = (name: string) => ({ name, statement: "permit(principal, action, resource);" });
describe("project status handler", () => {
  test("reports resources deployed by a legacy CLI using resources.stackName", async () => {
    const stackName = "AgentCore-orders-default";
    const backend = new CdkBackend({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      enableTransactionSearch: async () => {},
      resolveCredentials: async () => async () => ({
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      }),
      resolveAccount: async () => DEFAULT_TARGET.account,
      describeStack: async (_region, _credentials, reference) =>
        reference === stackName
          ? {
              StackName: stackName,
              CreationTime: new Date(0),
              StackStatus: "CREATE_COMPLETE",
              Outputs: [
                {
                  ExportName: `${stackName}-Harness-orders-Arn`,
                  OutputValue: `${ARN}:harness/orders-1`,
                },
              ],
            }
          : undefined,
    });
    const subject = statusCommand(backend);
    const projectRoot = await inProject({ harnesses: [{ name: "orders", path: "app/orders" }] });
    const stateDirectory = join(projectRoot, "agentcore", ".cli");
    await mkdir(stateDirectory, { recursive: true });
    await Bun.write(
      join(stateDirectory, "deployed-state.json"),
      JSON.stringify({
        targets: {
          default: {
            resources: { stackName },
          },
        },
      }),
    );

    await subject.run(["--json"]);

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: DEFAULT_TARGET.region,
      targetAccount: DEFAULT_TARGET.account,
      awsIdentity: DEFAULT_IDENTITY,
      resources: [
        {
          resourceType: "harness",
          name: "orders",
          deploymentState: "deployed",
          arn: `${ARN}:harness/orders-1`,
        },
      ],
    });
  });

  test("labels ARNs recursively and preserves identifiers for resources without ARNs", async () => {
    const subject = testStatusCommand([
      HARNESS_ROW,
      deployed("memory", "shortTerm", { arn: `${ARN}:memory/shortTerm-1` }),
      deployed("policy-engine", "guards", { arn: `${ARN}:policy-engine/guards-1` }, [
        deployed("policy", "noPii", { arn: `${ARN}:policy/noPii-1` }),
      ]),
      deployed("gateway", "tools", { arn: `${ARN}:gateway/tools-1` }, [
        deployed("gateway-target", "search", { id: "target-1" }),
      ]),
      localOnly("policy-engine", "empty"),
    ]);
    await inProject({
      memories: [memory("shortTerm")],
      policyEngines: [
        { name: "guards", policies: [policy("noPii")] },
        { name: "empty", policies: [] },
      ],
    });

    await subject.run();

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      targetAccount: DEFAULT_TARGET.account,
      awsIdentity: DEFAULT_IDENTITY,
      resources: [
        HARNESS_ROW,
        {
          resourceType: "memory",
          name: "shortTerm",
          deploymentState: "deployed",
          arn: `${ARN}:memory/shortTerm-1`,
        },
        {
          resourceType: "policy-engine",
          name: "guards",
          deploymentState: "deployed",
          arn: `${ARN}:policy-engine/guards-1`,
          children: [
            {
              resourceType: "policy",
              name: "noPii",
              deploymentState: "deployed",
              arn: `${ARN}:policy/noPii-1`,
            },
          ],
        },
        {
          resourceType: "gateway",
          name: "tools",
          deploymentState: "deployed",
          arn: `${ARN}:gateway/tools-1`,
          children: [
            {
              resourceType: "gateway-target",
              name: "search",
              deploymentState: "deployed",
              id: "target-1",
            },
          ],
        },
        { resourceType: "policy-engine", name: "empty", deploymentState: "local-only" },
      ],
    });
  });

  test("omits identifier for resources the stack does not hold", async () => {
    const subject = testStatusCommand([
      HARNESS_ROW,
      deployed("memory", "shortTerm", { arn: `${ARN}:memory/shortTerm-1` }),
      localOnly("memory", "longTerm"),
    ]);
    await inProject({ memories: [memory("shortTerm"), memory("longTerm")] });

    await subject.run();

    expect(subject.json().resources).toEqual([
      HARNESS_ROW,
      {
        resourceType: "memory",
        name: "shortTerm",
        deploymentState: "deployed",
        arn: `${ARN}:memory/shortTerm-1`,
      },
      { resourceType: "memory", name: "longTerm", deploymentState: "local-only" },
    ]);
  });

  test("reports every resource local-only when nothing is deployed", async () => {
    const subject = testStatusCommand([HARNESS_ROW, localOnly("memory", "shortTerm")]);
    await inProject({ memories: [memory("shortTerm")] });

    await subject.run();

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      targetAccount: DEFAULT_TARGET.account,
      awsIdentity: DEFAULT_IDENTITY,
      resources: [
        HARNESS_ROW,
        { resourceType: "memory", name: "shortTerm", deploymentState: "local-only" },
      ],
    });
  });

  test("rejects a project that declares no targets, without reaching the backend", async () => {
    const subject = testStatusCommand([localOnly("memory", "shortTerm")]);
    await inProject({ memories: [memory("shortTerm")] }, []);

    await expect(subject.run()).rejects.toThrow(
      /No deployment targets are configured for project 'orders'\. Please deploy your project using 'agentcore deploy'\./,
    );
    expect(subject.targets).toEqual([]);
  });

  test("--target selects another target, and an unknown one is rejected", async () => {
    const subject = testStatusCommand([]);
    await inProject();

    await subject.run(["--target", "staging"]);

    expect(subject.targets).toEqual([STAGING_TARGET]);
    expect(subject.json()).toMatchObject({ target: "staging", region: "eu-west-1" });

    await expect(subject.run(["--target", "typo"])).rejects.toThrow(
      /has no deployment target named 'typo'/,
    );
  });
});

describe("project status AWS identity", () => {
  async function runWithTelemetry(subject: ReturnType<typeof testStatusCommand>, args: string[]) {
    const { client, filePath, cleanup } = await getTestTelemetryClient();
    cleanups.push(cleanup);
    await withTelemetry(ValueContext.EmptyContext(), client, (ctx) => subject.run(args, ctx));
    return filePath;
  }

  test("names the profile from AWS_PROFILE and writes no warning when the accounts match", async () => {
    process.env.AWS_PROFILE = "dev";
    // AWS_PROFILE wins over keys in the environment, as in the SDK's default chain.
    process.env.AWS_ACCESS_KEY_ID = "access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
    const subject = testStatusCommand();
    await inProject();

    await subject.run();

    expect(subject.json().awsIdentity).toEqual({
      credentialSource: "profile",
      profile: "dev",
      success: true,
      account: DEFAULT_TARGET.account,
    });
    expect(subject.io.stderr()).toBe("");
  });

  test("reports environment credentials when access keys are set without AWS_PROFILE", async () => {
    process.env.AWS_ACCESS_KEY_ID = "access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
    const subject = testStatusCommand();
    await inProject();

    await subject.run();

    expect(subject.json().awsIdentity).toEqual({
      credentialSource: "environment",
      success: true,
      account: DEFAULT_TARGET.account,
    });
  });

  test("resolves the identity in the selected target's region", async () => {
    const regions: string[] = [];
    const subject = testStatusCommand([], testIO(), async (region) => {
      regions.push(region);
      return STAGING_TARGET.account;
    });
    await inProject();

    await subject.run(["--target", "staging"]);

    expect(regions).toEqual([STAGING_TARGET.region]);
    expect(subject.json()).toMatchObject({
      targetAccount: STAGING_TARGET.account,
      awsIdentity: { success: true, account: STAGING_TARGET.account },
    });
  });

  test("warns on stderr when the credentials belong to another account", async () => {
    const subject = testStatusCommand([HARNESS_ROW], testIO(), async () => "999988887777");
    await inProject();

    const telemetry = await runWithTelemetry(subject, []);

    expect(subject.json()).toMatchObject({
      targetAccount: DEFAULT_TARGET.account,
      awsIdentity: { success: true, account: "999988887777" },
      resources: [HARNESS_ROW],
    });
    expect(subject.io.stderr()).toBe(
      "warning: The active AWS credentials belong to account 999988887777, " +
        "but target 'default' is configured for account 111122223333.",
    );
    await assertMetricEmitted(telemetry, "cli.command_run", {
      command_path: "/agentcore/status",
      exit_reason: "success",
      aws_identity_resolved: true,
      aws_account_mismatch: true,
    });
  });

  test("reports missing credentials instead of failing", async () => {
    const subject = testStatusCommand([HARNESS_ROW], testIO(), async () => {
      throw new Error("Could not load credentials from any providers");
    });
    await inProject();

    const telemetry = await runWithTelemetry(subject, []);

    expect(subject.json()).toMatchObject({
      awsIdentity: {
        credentialSource: "profile",
        profile: "default",
        success: false,
        error: "Could not load credentials from any providers",
      },
      resources: [HARNESS_ROW],
    });
    expect(subject.io.stderr()).toBe(
      "warning: AWS account unavailable (profile default): " +
        "Could not load credentials from any providers",
    );
    await assertMetricEmitted(telemetry, "cli.command_run", {
      command_path: "/agentcore/status",
      exit_reason: "success",
      aws_identity_resolved: false,
      aws_account_mismatch: false,
    });
  });
});

describe("project status dispatch", () => {
  // The bare-invocation tests above run without a TTY and assert the exact
  // JSON envelope, which pins the non-TTY headless path; these cover how a TTY
  // changes (and does not change) the dispatch.
  test("bare status in a TTY session opens the TUI instead of printing JSON", async () => {
    const tty = ttyTestIO();
    const subject = testStatusCommand([HARNESS_ROW], tty.streams);
    await inProject();

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = subject.run().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The screen never finishes on its own; Ctrl+C (re-sent until the app
    // reacts) closes it and resolves the route cleanly.
    await waitFor(
      () => {
        if (!settled) tty.stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(subject.io.stdout()).not.toContain('"projectName"');
  }, 10000);

  test("an explicitly passed --target stays headless even in a TTY", async () => {
    const subject = testStatusCommand([HARNESS_ROW], ttyTestIO().streams);
    await inProject();

    await subject.run(["--target", "default"]);

    expect(subject.json()).toMatchObject({ projectName: "orders", target: "default" });
  });

  test("--json stays headless even in a TTY", async () => {
    const subject = testStatusCommand([HARNESS_ROW], ttyTestIO().streams);
    await inProject();

    await subject.run(["--json"]);

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      targetAccount: DEFAULT_TARGET.account,
      awsIdentity: DEFAULT_IDENTITY,
      resources: [HARNESS_ROW],
    });
  });
});
