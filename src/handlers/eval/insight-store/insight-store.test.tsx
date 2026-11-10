import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BedrockAgentCoreControlClient,
  GetAgentInsightStoreCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { InputValidationError } from "../../../errors";
import {
  createSilentLogger,
  expectError,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Record with RECORD=1 against an account enrolled for Agent Insights, whose Store
// is enabled. The update re-applies the AWS owned key, so a recording changes
// nothing a customer would notice beyond a short UPDATING window.
const STORE_ID = "default-insight-store";

function createFixtureCore(): CoreClient {
  return new CoreClient({ ...fixtureFactories(FIXTURES), logger: createSilentLogger() });
}

async function run(args: string[], core: CoreClient | TestCoreClient = createFixtureCore()) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "eval", "insight-store", ...args, "--region", REGION]);
  return io;
}

// Outside the fixture boundary on purpose: polling through the recording client
// would overwrite the get fixture with a later state than the get golden shows.
async function waitUntilSettled(): Promise<void> {
  if (!isRecording()) return;
  const client = new BedrockAgentCoreControlClient({ region: REGION });
  for (let attempt = 0; attempt < 60; attempt++) {
    const store = await client.send(
      new GetAgentInsightStoreCommand({ agentInsightStoreId: STORE_ID }),
    );
    if (store.status !== "UPDATING") return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`${STORE_ID} did not leave UPDATING`);
}

describe("eval insight-store command hierarchy", () => {
  test("mounts insight and insight-store last under eval", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const evalRouter = root.children().find((c) => c.name() === "eval");
    expect(evalRouter?.children().map((c) => c.name())).toEqual([
      "evaluator",
      "online-eval",
      "dataset",
      "batch-evaluation",
      "ondemand",
      "config-bundle",
      "ab-test",
      "recommendation",
      "insight",
      "insight-store",
    ]);
    const store = evalRouter?.children().find((c) => c.name() === "insight-store");
    expect(store?.children().map((c) => c.name())).toEqual(["list", "get", "update"]);
  });

  test("prints help for a bare `eval insight-store` without an SDK call", async () => {
    const core = new TestCoreClient();
    const io = await run([], core);
    expect(io.stdout()).toContain("Usage: agentcore eval insight-store");
    expect(core.eval.calls).toEqual([]);
  });
});

describe("eval insight-store", () => {
  test(
    "re-applies the AWS owned key and reports UPDATING",
    async () => {
      const io = await run(["update", "--id", STORE_ID, "--encryption-mode", "AWS_OWNED_KMS_KEY"]);
      matchGolden(FIXTURES, "update-encryption.golden.json", io.stdout());
      await waitUntilSettled();
    },
    { timeout: 660_000 },
  );

  test("lists the account's Store", async () => {
    const io = await run(["list"]);
    matchGolden(FIXTURES, "list.golden.json", io.stdout());
  });

  test("gets the Store by ID", async () => {
    const io = await run(["get", "--id", STORE_ID]);
    matchGolden(FIXTURES, "get.golden.json", io.stdout());
  });
});

describe("eval insight-store update flag rules", () => {
  const base = ["update", "--id", STORE_ID];

  test.each<[string, string[], string]>([
    ["neither change", [], "specify exactly one of --enablement-status, --encryption-mode"],
    [
      "both changes",
      ["--enablement-status", "ENABLED", "--encryption-mode", "AWS_OWNED_KMS_KEY"],
      "specify exactly one of --enablement-status, --encryption-mode",
    ],
    [
      "a customer managed key without its ARN",
      ["--encryption-mode", "CUSTOMER_MANAGED_KMS"],
      "'--encryption-mode CUSTOMER_MANAGED_KMS' requires '--kms-key-arn'",
    ],
    [
      "an ARN with the AWS owned key",
      ["--encryption-mode", "AWS_OWNED_KMS_KEY", "--kms-key-arn", "arn:aws:kms:us-west-2:1:key/k"],
      "'--kms-key-arn' cannot be used with '--encryption-mode AWS_OWNED_KMS_KEY'",
    ],
    [
      "an ARN without --encryption-mode",
      ["--enablement-status", "ENABLED", "--kms-key-arn", "arn:aws:kms:us-west-2:1:key/k"],
      "'--kms-key-arn' requires '--encryption-mode CUSTOMER_MANAGED_KMS'",
    ],
    ["an unknown enablement status", ["--enablement-status", "OFF"], "--enablement-status"],
    ["an unknown encryption mode", ["--encryption-mode", "KMS"], "--encryption-mode"],
  ])("rejects %s before any AWS call", async (_, args, message) => {
    const core = new TestCoreClient();
    await expectError(run([...base, ...args], core), message, InputValidationError);
    expect(core.eval.calls).toEqual([]);
  });

  test("rejects a missing --id before any AWS call", async () => {
    const core = new TestCoreClient();
    await expectError(
      run(["update", "--enablement-status", "ENABLED"], core),
      "--id",
      InputValidationError,
    );
    expect(core.eval.calls).toEqual([]);
  });

  test("sends only the enablement status when no encryption flag is given", async () => {
    const core = new TestCoreClient();
    await run([...base, "--enablement-status", "DISABLED"], core);
    expect(core.eval.calls[0]?.method).toBe("updateAgentInsightStore");
    expect(core.eval.calls[0]?.args[1]).toEqual({ enablementStatus: "DISABLED" });
  });

  test("sends a customer managed key with its ARN", async () => {
    const core = new TestCoreClient();
    const arn = "arn:aws:kms:us-west-2:123456789012:key/1234abcd";
    await run([...base, "--encryption-mode", "CUSTOMER_MANAGED_KMS", "--kms-key-arn", arn], core);
    expect(core.eval.calls[0]?.args[1]).toEqual({
      encryptionConfiguration: { mode: "CUSTOMER_MANAGED_KMS", kmsKeyArn: arn },
    });
  });
});
