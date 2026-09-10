import { describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../core";
import { paymentServiceRoleName } from "../../core/paymentServiceRole";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

// End-to-end command-flow tests for the `payment` subtree's manager leaves.
//
// Each test builds the real root handler over a real CoreClient whose SDK
// clients are the fixture-backed fakes, then drives it through `route()` exactly
// as the CLI does, so one test covers parsing, middleware, the leaf handler,
// PaymentClient, and the rendered output.
//
// Record with:
//   RECORD=1 AWS_PROFILE=deploy bun test src/handlers/payment/payment.test.tsx
// The read-only goldens use a manager that already exists in the test account.
// The write flow creates a manager named AgentCoreCliPaymentE2E, provisions its
// default service role, updates it, and deletes the manager again (the role is
// intentionally left in place, as the harness flow leaves its execution role).

const FIXTURES = join(import.meta.dir, "__fixtures__");
const REGION = "us-west-2";
const EXISTING_MANAGER_ID = "mypaymentmanager-o4ks3qfgtb";
// The write flow records in a second region: the test account's us-west-2
// payment-manager quota is used up by long-lived bug-bash managers. Fixtures are
// keyed by operation and input, not region, so the two regions never collide.
const WRITE_REGION = "us-east-1";
// Fixtures are keyed by operation and input, so a `get` issued after the delete
// would overwrite the READY response the earlier readiness poll replays. Reads
// that expect the resource to be gone record into their own directory.
const AFTER_DELETE_FIXTURES = join(FIXTURES, "after-delete");
const E2E_NAME = "AgentCoreCliPaymentE2E";
// Generous timeouts: in record mode, readiness polls wait on real control-plane
// transitions. Replay never sleeps.
const FLOW_TIMEOUT = 600_000;

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(fixtures);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

function createRoot(core = createFixtureCore(), io = testIO()) {
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return { root, io };
}

async function run(args: string[], region = REGION, fixtures = FIXTURES): Promise<string> {
  const { root, io } = createRoot(createFixtureCore(fixtures));
  await root.route(["node", "agentcore", ...args, "--region", region]);
  return io.stdout();
}

// pollUntil re-runs `command` until `done(parsed output)` is true. Polling only
// sleeps in record mode; in replay the fixture already holds the settled state
// (the last recorded poll), so the first read satisfies `done`.
async function pollUntil(command: string[], done: (output: any) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const parsed = JSON.parse(await run(command, WRITE_REGION));
    if (done(parsed)) return;
    if (!isRecording()) {
      throw new Error(
        `Replayed fixture for \`${command.join(" ")}\` is not in the awaited state; re-record.`,
      );
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${command.join(" ")}\``);
}

// pollUntilGone re-runs a `get` until the service reports the resource missing.
async function pollUntilGone(command: string[]): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await run(command, WRITE_REGION, AFTER_DELETE_FIXTURES);
    } catch (error) {
      if (/ResourceNotFound|not found/i.test((error as Error).message)) return;
      throw error;
    }
    if (!isRecording()) {
      throw new Error(`Replayed fixture for \`${command.join(" ")}\` still exists; re-record.`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${command.join(" ")}\` to disappear`);
}

describe("payment command hierarchy", () => {
  test("registers manager, connector, session, and instrument sub-routers", () => {
    const { root } = createRoot();
    const payment = root.children().find((child) => child.name() === "payment");

    expect(payment?.children().map((child) => child.name())).toEqual([
      "manager",
      "connector",
      "session",
      "instrument",
    ]);
    expect(
      payment
        ?.children()
        .find((child) => child.name() === "manager")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["create", "get", "list", "update", "delete"]);
  });
});

describe("payment manager list", () => {
  test("prints the listed payment managers as JSON", async () => {
    const out = await run(["payment", "manager", "list", "--json"]);
    matchGolden(FIXTURES, "manager-list.golden.json", out);
  });

  test("output is valid JSON containing a paymentManagers array", async () => {
    const parsed = JSON.parse(await run(["payment", "manager", "list", "--json"]));
    expect(Array.isArray(parsed.paymentManagers)).toBe(true);
  });
});

describe("payment manager get", () => {
  test("prints the manager detail as JSON for a given id", async () => {
    const out = await run(["payment", "manager", "get", "--id", EXISTING_MANAGER_ID]);
    matchGolden(FIXTURES, "manager-get.golden.json", out);
    expect(JSON.parse(out).paymentManagerId).toBe(EXISTING_MANAGER_ID);
  });

  test("errors when --id is omitted", async () => {
    await expect(run(["payment", "manager", "get", "--id", ""])).rejects.toThrow(/--id/);
  });
});

describe("payment manager write validation", () => {
  test.each(["create", "update"] as const)(
    "`%s` preserves explicit role and KMS references",
    async (command) => {
      const factories = fixtureFactories(FIXTURES);
      const sdk = mock(() => {
        throw new Error("unexpected SDK client creation");
      });
      for (const name of Object.keys(factories) as (keyof typeof factories)[]) {
        spyOn(factories, name).mockImplementation(sdk);
      }
      const send = mock(async () => ({}));
      spyOn(factories, "createControlClient").mockReturnValue({
        send,
      } as unknown as BedrockAgentCoreControlClient);
      const { root } = createRoot(new CoreClient({ ...factories, logger: createSilentLogger() }));
      const roleArn = "arn:aws:iam::123456789012:role/PaymentRole";
      const kmsKeyArn =
        "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012";

      await root.route([
        "node",
        "agentcore",
        "payment",
        "manager",
        command,
        ...(command === "create"
          ? ["--name", "ExplicitReferences"]
          : ["--id", EXISTING_MANAGER_ID]),
        "--role-arn",
        roleArn,
        "--kms-key-arn",
        kmsKeyArn,
        "--region",
        REGION,
      ]);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ roleArn, kmsKeyArn }) }),
      );
      expect(sdk).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["create", "role-arn"],
    ["create", "kms-key-arn"],
    ["update", "role-arn"],
    ["update", "kms-key-arn"],
  ] as const)("`%s` rejects empty --%s before Core or IO", async (command, flagName) => {
    const factories = fixtureFactories(FIXTURES);
    const sdk = mock(() => {
      throw new Error("unexpected SDK client creation");
    });
    for (const name of Object.keys(factories) as (keyof typeof factories)[]) {
      spyOn(factories, name).mockImplementation(sdk);
    }
    const core = new CoreClient({ ...factories, logger: createSilentLogger() });
    const call = spyOn(
      core.payment,
      command === "create" ? "createPaymentManager" : "updatePaymentManager",
    );
    const read = mock(() => {
      throw new Error("unexpected stdin read");
    });
    const stdin = new Readable({ read });
    const io = testIO();
    io.io.stdin = stdin as NodeJS.ReadStream;
    const { root } = createRoot(core, io);

    try {
      await expect(
        root.route([
          "node",
          "agentcore",
          "payment",
          "manager",
          command,
          ...(command === "create" ? ["--name", "EmptyReference"] : ["--id", EXISTING_MANAGER_ID]),
          `--${flagName}`,
          "",
          "--authorizer-type",
          "CUSTOM_JWT",
          "--authorizer-configuration",
          "-",
          "--region",
          REGION,
        ]),
      ).rejects.toThrow(`Invalid value for option '--${flagName}'`);
      expect(call).not.toHaveBeenCalled();
      expect(sdk).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe("");
    } finally {
      call.mockRestore();
      stdin.destroy();
    }
  });

  // Each write leaf declares its identifying flags optional (so a bare
  // invocation can fall through to the TUI once one exists) but requires them
  // at runtime. None of these reach the SDK, so no fixtures are involved.
  test("`create` errors when --name is omitted", async () => {
    await expect(run(["payment", "manager", "create", "--name", ""])).rejects.toThrow(/--name/);
  });

  test("`create` requires --authorizer-configuration for CUSTOM_JWT", async () => {
    await expect(
      run(["payment", "manager", "create", "--name", "Jwt", "--authorizer-type", "CUSTOM_JWT"]),
    ).rejects.toThrow(/CUSTOM_JWT requires --authorizer-configuration/);
  });

  test("`create` rejects --authorizer-configuration for AWS_IAM", async () => {
    await expect(
      run([
        "payment",
        "manager",
        "create",
        "--name",
        "Iam",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://example.test/.well-known/openid-configuration"}}',
      ]),
    ).rejects.toThrow(/valid only with CUSTOM_JWT/);
  });

  test("`create` rejects a malformed --authorizer-configuration", async () => {
    await expect(
      run([
        "payment",
        "manager",
        "create",
        "--name",
        "Jwt",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        "{not json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--authorizer-configuration'/);
  });

  test("`create` rejects a malformed tag", async () => {
    await expect(
      run(["payment", "manager", "create", "--name", "Tagged", "--tags", "novalue"]),
    ).rejects.toThrow(/Invalid tag/);
  });

  test("`update` errors when --id is omitted", async () => {
    await expect(run(["payment", "manager", "update", "--id", ""])).rejects.toThrow(/--id/);
  });

  test("`update` rejects --authorizer-configuration together with AWS_IAM", async () => {
    await expect(
      run([
        "payment",
        "manager",
        "update",
        "--id",
        "m-1",
        "--authorizer-type",
        "AWS_IAM",
        "--authorizer-configuration",
        "{}",
      ]),
    ).rejects.toThrow(/valid only with CUSTOM_JWT/);
  });

  test("`delete` errors when --id is omitted", async () => {
    await expect(run(["payment", "manager", "delete", "--id", ""])).rejects.toThrow(/--id/);
  });
});

// ─── write flow (create → update → delete) ───────────────────────────────────
//
// Drives the lifecycle of a real payment manager, in order, through route().
// In record mode it hits the live control plane (and IAM for the default
// service role) and persists every exchange; replays are offline and instant.
// Later tests consume the id parsed from earlier output.

const state: { managerId?: string } = {};

describe("payment manager write flow", () => {
  test(
    "`create` provisions a default service role and creates the manager",
    async () => {
      const out = await run(
        [
          "payment",
          "manager",
          "create",
          "--name",
          E2E_NAME,
          "--description",
          "Created by the agentcore CLI end-to-end test",
          "--tags",
          "created-by=agentcore-cli-e2e",
        ],
        WRITE_REGION,
      );
      matchGolden(FIXTURES, "manager-create.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.name).toBe(E2E_NAME);
      expect(parsed.authorizerType).toBe("AWS_IAM");
      // No --role-arn was passed: the default service role was provisioned.
      expect(parsed.roleArn).toContain(paymentServiceRoleName(E2E_NAME, WRITE_REGION));
      expect(parsed.paymentManagerId).toBeDefined();
      state.managerId = parsed.paymentManagerId;

      await pollUntil(
        ["payment", "manager", "get", "--id", state.managerId!],
        (o) => o.status === "READY",
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`update` changes the description",
    async () => {
      const out = await run(
        [
          "payment",
          "manager",
          "update",
          "--id",
          state.managerId!,
          "--description",
          "Updated by the agentcore CLI end-to-end test",
        ],
        WRITE_REGION,
      );
      matchGolden(FIXTURES, "manager-update.golden.json", out);
      expect(JSON.parse(out).paymentManagerId).toBe(state.managerId);

      await pollUntil(
        ["payment", "manager", "get", "--id", state.managerId!],
        (o) => o.status === "READY" && /Updated by/.test(o.description ?? ""),
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`delete` deletes the manager",
    async () => {
      const out = await run(
        ["payment", "manager", "delete", "--id", state.managerId!],
        WRITE_REGION,
      );
      matchGolden(FIXTURES, "manager-delete.golden.json", out);
      expect(JSON.parse(out).status).toBe("DELETING");

      await pollUntilGone(["payment", "manager", "get", "--id", state.managerId!]);
    },
    FLOW_TIMEOUT,
  );
});
