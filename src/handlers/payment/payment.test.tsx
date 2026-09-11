import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
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
  waitFor,
} from "../../testing";

const FIXTURES = join(import.meta.dir, "__fixtures__");
// The recorded manager lifecycle uses us-east-1; read fixtures use us-west-2.
const REGION = "us-east-1";
const E2E_NAME = "AgentCoreCliPaymentE2E";

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  return new CoreClient({ ...fixtureFactories(fixtures), logger: createSilentLogger() });
}

async function run(args: string[], core = createFixtureCore(), io = testIO()): Promise<string> {
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "payment", "manager", ...args, "--region", REGION]);
  return io.stdout();
}

describe("payment manager write inputs", () => {
  test.each(["create", "update"] as const)(
    "%s preserves explicit references and JWT configuration from stdin",
    async (command) => {
      const factories = fixtureFactories(FIXTURES);
      const control = factories.createControlClient({ region: REGION });
      spyOn(control, "send").mockImplementation(async () => ({}));
      const core = new CoreClient({
        ...factories,
        createControlClient: () => control,
        logger: createSilentLogger(),
      });
      const call = spyOn(
        core.payment,
        command === "create" ? "createPaymentManager" : "updatePaymentManager",
      );
      const roleArn = "arn:aws:iam::123456789012:role/PaymentRole";
      const kmsKeyArn =
        "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
      const authorizerConfiguration = {
        customJWTAuthorizer: {
          discoveryUrl: "https://example.test/.well-known/openid-configuration",
        },
      };

      await run(
        [
          command,
          ...(command === "create"
            ? ["--name", "ExplicitReferences", "--authorizer-type", "CUSTOM_JWT"]
            : ["--id", "manager-1", "--description", ""]),
          "--role-arn",
          roleArn,
          "--kms-key-arn",
          kmsKeyArn,
          "--authorizer-configuration",
          "-",
          "--client-token",
          "token-1",
        ],
        core,
        testIO({ stdin: JSON.stringify(authorizerConfiguration) }),
      );

      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(
        {
          ...(command === "create"
            ? { name: "ExplicitReferences", authorizerType: "CUSTOM_JWT" }
            : { paymentManagerId: "manager-1", description: "" }),
          roleArn,
          kmsKeyArn,
          authorizerConfiguration,
          clientToken: "token-1",
        },
        { region: REGION },
      );
    },
  );

  test.each([
    ["create", "role-arn"],
    ["create", "kms-key-arn"],
    ["update", "role-arn"],
    ["update", "kms-key-arn"],
  ] as const)("%s rejects empty --%s before Core or stdin", async (command, flag) => {
    const core = createFixtureCore();
    const call = spyOn(
      core.payment,
      command === "create" ? "createPaymentManager" : "updatePaymentManager",
    );
    const io = testIO({ stdin: "{}" });

    await expect(
      run(
        [
          command,
          ...(command === "create" ? ["--name", "EmptyReference"] : ["--id", "manager-1"]),
          `--${flag}`,
          "",
          "--authorizer-type",
          "CUSTOM_JWT",
          "--authorizer-configuration",
          "-",
        ],
        core,
        io,
      ),
    ).rejects.toThrow(`Invalid value for option '--${flag}'`);
    expect(call).not.toHaveBeenCalled();
    expect(io.io.stdin.readableLength).toBe(2);
    expect(io.stdout()).toBe("");
  });

  test("enforces JWT configuration combinations for create and update", async () => {
    await expect(
      run(["create", "--name", "Jwt", "--authorizer-type", "CUSTOM_JWT"]),
    ).rejects.toThrow("CUSTOM_JWT requires --authorizer-configuration");
    await expect(
      run(["create", "--name", "Iam", "--authorizer-configuration", "{}"]),
    ).rejects.toThrow("--authorizer-configuration is valid only with CUSTOM_JWT");
    await expect(
      run([
        "update",
        "--id",
        "manager-1",
        "--authorizer-type",
        "AWS_IAM",
        "--authorizer-configuration",
        "{}",
      ]),
    ).rejects.toThrow("--authorizer-configuration is valid only with CUSTOM_JWT");
  });
});

test("payment manager lifecycle replays default-role creation, update, and deletion through root/Core", async () => {
  const created = await run([
    "create",
    "--name",
    E2E_NAME,
    "--description",
    "Created by the agentcore CLI end-to-end test",
    "--tags",
    "created-by=agentcore-cli-e2e",
  ]);
  matchGolden(FIXTURES, "manager-create.golden.json", created);
  const manager = JSON.parse(created);
  expect(manager.authorizerType).toBe("AWS_IAM");
  expect(manager.roleArn).toContain(paymentServiceRoleName(E2E_NAME, REGION));
  const scoped = ["--id", manager.paymentManagerId];
  await waitFor(
    async () => JSON.parse(await run(["get", ...scoped])).status === "READY",
    isRecording() ? 300_000 : 0,
    5_000,
  );

  const description = "Updated by the agentcore CLI end-to-end test";
  const updated = await run(["update", ...scoped, "--description", description]);
  matchGolden(FIXTURES, "manager-update.golden.json", updated);
  await waitFor(
    async () => {
      const detail = JSON.parse(await run(["get", ...scoped]));
      return detail.status === "READY" && detail.description === description;
    },
    isRecording() ? 300_000 : 0,
    5_000,
  );

  const deleted = await run(["delete", ...scoped]);
  matchGolden(FIXTURES, "manager-delete.golden.json", deleted);
  expect(JSON.parse(deleted).status).toBe("DELETING");

  // The same Get request has a separate post-delete fixture.
  await waitFor(
    async () => {
      try {
        await run(["get", ...scoped], createFixtureCore(join(FIXTURES, "after-delete")));
        return false;
      } catch (error) {
        expect(error).toMatchObject({ name: "ResourceNotFoundException" });
        return true;
      }
    },
    isRecording() ? 300_000 : 0,
    5_000,
  );
}, 1_800_000);
