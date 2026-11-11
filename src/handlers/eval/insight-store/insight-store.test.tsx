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
  waitFor,
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

const SETTLE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 10_000;

// Outside the fixture boundary on purpose: polling through the recording client
// would overwrite the get fixture with a later state than the get golden shows.
async function waitUntilSettled(): Promise<void> {
  if (!isRecording()) return;
  const client = new BedrockAgentCoreControlClient({ region: REGION });
  await waitFor(
    async () => {
      const store = await client.send(
        new GetAgentInsightStoreCommand({ agentInsightStoreId: STORE_ID }),
      );
      return store.status !== "UPDATING";
    },
    SETTLE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
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

describe("eval insight-store update flags", () => {
  const base = ["update", "--id", STORE_ID];

  test.each<[string, string[], string]>([
    ["a missing --id", ["update", "--enablement-status", "ENABLED"], "--id"],
    [
      "an unknown enablement status",
      [...base, "--enablement-status", "OFF"],
      "--enablement-status",
    ],
    ["an unknown encryption mode", [...base, "--encryption-mode", "KMS"], "--encryption-mode"],
    ["an empty --kms-key-arn", [...base, "--kms-key-arn", ""], "--kms-key-arn"],
  ])("rejects %s before any AWS call", async (_, args, message) => {
    const core = new TestCoreClient();
    await expectError(run(args, core), message, InputValidationError);
    expect(core.eval.calls).toEqual([]);
  });

  test.each<[string, string[], object]>([
    ["no change", [], { enablementStatus: undefined, encryptionConfiguration: undefined }],
    [
      "only the enablement status",
      ["--enablement-status", "DISABLED"],
      { enablementStatus: "DISABLED", encryptionConfiguration: undefined },
    ],
    [
      "only the encryption mode",
      ["--encryption-mode", "AWS_OWNED_KMS_KEY"],
      {
        enablementStatus: undefined,
        encryptionConfiguration: { mode: "AWS_OWNED_KMS_KEY", kmsKeyArn: undefined },
      },
    ],
    [
      "both changes, to enable a disabled Store on a new key",
      [
        "--enablement-status",
        "ENABLED",
        "--encryption-mode",
        "CUSTOMER_MANAGED_KMS",
        "--kms-key-arn",
        "arn:aws:kms:us-west-2:123456789012:key/1234abcd",
      ],
      {
        enablementStatus: "ENABLED",
        encryptionConfiguration: {
          mode: "CUSTOMER_MANAGED_KMS",
          kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/1234abcd",
        },
      },
    ],
    [
      "a key ARN without a mode",
      ["--kms-key-arn", "arn:aws:kms:us-west-2:1:key/k"],
      {
        enablementStatus: undefined,
        encryptionConfiguration: { mode: undefined, kmsKeyArn: "arn:aws:kms:us-west-2:1:key/k" },
      },
    ],
  ])("passes %s to the service unchanged", async (_, args, update) => {
    const core = new TestCoreClient();
    await run([...base, ...args], core);
    expect(core.eval.calls[0]?.method).toBe("updateAgentInsightStore");
    expect(core.eval.calls[0]?.args[1]).toEqual(update);
  });
});
