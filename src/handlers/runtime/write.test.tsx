import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  expectError,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  testIO,
} from "../../testing";
import { TestGlobalConfigAccessor } from "../../testing/globalConfig";
import { InputValidationError, UserCancellationError } from "../../errors";
import { createRootHandler } from "../index";

// Command-flow tests for `runtime create`, `update`, and `delete`, in the style of
// harness.test.tsx: the real root handler over a real CoreClient whose SDK
// clients replay the golden files in __fixtures__/write.
//
// These fixtures were synthesized from the SDK's response shapes, not recorded:
// recording creates a real Runtime from RUNTIME_IMAGE, which must exist in the
// recording account's region. Re-record with RECORD=1 against such an account.

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__", "write");
const RUNTIME_NAME = "AgentCoreCliRuntimeE2E";
const RUNTIME_IMAGE = "111122223333.dkr.ecr.us-west-2.amazonaws.com/agentcore-cli-e2e:v1";

function createFixtureCore(): CoreClient {
  const {
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    createXrayClient,
    createApplicationSignalsClient,
  } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    createXrayClient,
    createApplicationSignalsClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { stdout: io.stdout(), stderr: io.stderr() };
}

function testRuntimeCommand(options: { isTTY?: boolean; stdin?: string } = {}) {
  const core = new TestCoreClient();
  const io = testIO(options);
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
  };
}

describe("runtime create, update, delete (recorded flow)", () => {
  test("`runtime create` provisions a default role scoped to the image and creates the Runtime", async () => {
    const { stdout, stderr } = await run([
      "runtime",
      "create",
      "--name",
      RUNTIME_NAME,
      "--container-uri",
      RUNTIME_IMAGE,
      "--environment-variables",
      '{"LOG_LEVEL":"info"}',
      "--tags",
      "created-by=agentcore-cli-e2e",
    ]);
    matchGolden(FIXTURES, "create.golden.json", stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentRuntimeId).toStartWith(`${RUNTIME_NAME}-`);
    expect(stderr).toContain(`agentcore invoke --runtime ${parsed.agentRuntimeArn}`);
  });

  test("`runtime update` resolves the Runtime by name and keeps unchanged settings", async () => {
    const { stdout } = await run([
      "runtime",
      "update",
      "--runtime",
      RUNTIME_NAME,
      "--description",
      "updated by the agentcore CLI test",
    ]);
    matchGolden(FIXTURES, "update.golden.json", stdout);
    expect(JSON.parse(stdout).agentRuntimeVersion).toBe("2");
  });

  test("`runtime delete --yes` deletes the Runtime", async () => {
    const { stdout } = await run([
      "runtime",
      "delete",
      "--runtime",
      `${RUNTIME_NAME}-Ab12Cd34Ef`,
      "--yes",
    ]);
    matchGolden(FIXTURES, "delete.golden.json", stdout);
    expect(JSON.parse(stdout).status).toBe("DELETING");
  });
});

describe("runtime create flags", () => {
  test("requires --name and --container-uri", async () => {
    const subject = testRuntimeCommand();
    await expectError(
      subject.route(["runtime", "create", "--container-uri", RUNTIME_IMAGE]),
      /--name/,
      InputValidationError,
    );
    await expectError(
      subject.route(["runtime", "create", "--name", RUNTIME_NAME]),
      /--container-uri/,
      InputValidationError,
    );
  });

  test.each([
    "docker.io/library/python:3.12",
    "123.dkr.ecr.us-west-2.amazonaws.com/repo:tag",
    "111122223333.dkr.ecr.us-west-2.amazonaws.com/Repo:tag",
  ])("rejects the non-ECR or malformed image URI %s", async (uri) => {
    const subject = testRuntimeCommand();
    await expectError(
      subject.route(["runtime", "create", "--name", RUNTIME_NAME, "--container-uri", uri]),
      /must be an ECR image URI/,
      InputValidationError,
    );
    expect(subject.core.runtime.calls).toEqual([]);
  });

  test("maps flags onto the create request", async () => {
    const subject = testRuntimeCommand();
    await subject.route([
      "runtime",
      "create",
      "--name",
      RUNTIME_NAME,
      "--container-uri",
      "public.ecr.aws/example/agent:latest",
      "--execution-role-arn",
      "arn:aws:iam::111122223333:role/Mine",
      "--protocol",
      "MCP",
      "--network-mode",
      "VPC",
      "--network-config",
      '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
      "--lifecycle-configuration",
      '{"idleRuntimeSessionTimeout":900}',
      "--tags",
      "team=agents",
    ]);
    expect(subject.core.runtime.calls[0]?.args[0]).toEqual({
      runtimeName: RUNTIME_NAME,
      containerUri: "public.ecr.aws/example/agent:latest",
      executionRoleArn: "arn:aws:iam::111122223333:role/Mine",
      description: undefined,
      protocol: "MCP",
      environmentVariables: undefined,
      networkConfiguration: {
        networkMode: "VPC",
        networkModeConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: ["sg-0123456789abcdef0"],
        },
      },
      authorizerConfiguration: undefined,
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900 },
      tags: { team: "agents" },
    });
  });

  test("requires --network-config with --network-mode VPC, and the reverse", async () => {
    const subject = testRuntimeCommand();
    const base = ["runtime", "create", "--name", RUNTIME_NAME, "--container-uri", RUNTIME_IMAGE];
    await expectError(
      subject.route([...base, "--network-mode", "VPC"]),
      "--network-mode VPC requires --network-config",
      InputValidationError,
    );
    await expectError(
      subject.route([...base, "--network-config", '{"subnets":[],"securityGroups":[]}']),
      "--network-config requires --network-mode VPC",
      InputValidationError,
    );
  });
});

describe("runtime update flags", () => {
  test("resolves an ARN in its own region and can clear the authorizer", async () => {
    const subject = testRuntimeCommand();
    const arn = `arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/${RUNTIME_NAME}-Ab12Cd34Ef`;
    await subject.route([
      "runtime",
      "update",
      "--runtime",
      arn,
      "--container-uri",
      RUNTIME_IMAGE,
      "--clear-authorizer-configuration",
    ]);
    const update = subject.core.runtime.calls.find((call) => call.method === "updateRuntime");
    expect(update?.args[0]).toMatchObject({
      runtimeId: arn,
      containerUri: RUNTIME_IMAGE,
      authorizerConfiguration: null,
    });
    expect(update?.args[1]).toMatchObject({ region: "eu-west-1" });
  });

  test("rejects --clear-authorizer-configuration with --authorizer-configuration", async () => {
    const subject = testRuntimeCommand();
    await expectError(
      subject.route([
        "runtime",
        "update",
        "--runtime",
        RUNTIME_NAME,
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://example.com/.well-known/openid-configuration"}}',
        "--clear-authorizer-configuration",
      ]),
      "cannot be combined",
      InputValidationError,
    );
  });
});

describe("runtime delete confirmation", () => {
  test("refuses to delete without --yes when it cannot prompt", async () => {
    const subject = testRuntimeCommand();
    await expectError(
      subject.route(["runtime", "delete", "--runtime", RUNTIME_NAME]),
      "re-run with --yes",
      InputValidationError,
    );
    expect(subject.core.runtime.calls.map((call) => call.method)).not.toContain("deleteRuntime");
  });

  test("deletes after the user confirms", async () => {
    const subject = testRuntimeCommand({ isTTY: true, stdin: "y\n" });
    await subject.route(["runtime", "delete", "--runtime", RUNTIME_NAME]);
    expect(subject.io.stderr()).toContain(`Delete Runtime ${RUNTIME_NAME}?`);
    expect(subject.core.runtime.calls.map((call) => call.method)).toContain("deleteRuntime");
  });

  test("cancels when the user declines", async () => {
    const subject = testRuntimeCommand({ isTTY: true, stdin: "n\n" });
    await expect(
      subject.route(["runtime", "delete", "--runtime", RUNTIME_NAME]),
    ).rejects.toBeInstanceOf(UserCancellationError);
    expect(subject.core.runtime.calls.map((call) => call.method)).not.toContain("deleteRuntime");
  });

  test("passes --delete-execution-role through", async () => {
    const subject = testRuntimeCommand();
    await subject.route([
      "runtime",
      "delete",
      "--runtime",
      RUNTIME_NAME,
      "--yes",
      "--delete-execution-role",
    ]);
    const call = subject.core.runtime.calls.find((entry) => entry.method === "deleteRuntime");
    expect(call?.args[0]).toEqual({ runtimeId: RUNTIME_NAME, deleteExecutionRole: true });
  });
});
