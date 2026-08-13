import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DeleteConfigurationBundleCommand,
  GetConfigurationBundleCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { createControlClient } from "../../../core/factories";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  settle,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const BUNDLE_NAME = "agentcore_cli_config_bundle_fixture";
const COMPONENT_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:314146320088:runtime/stmFixes_StmFixesAgent-XsFfJU4cAp";
const COMPONENTS_V1 = {
  [COMPONENT_ARN]: {
    configuration: {
      system_prompt: "Configuration bundle fixture version one.",
      settings: { revision: 1 },
    },
  },
};
const COMPONENTS_V2 = {
  [COMPONENT_ARN]: {
    configuration: {
      system_prompt: "Configuration bundle fixture version two.",
      settings: { revision: 2 },
    },
  },
};

// Record with:
// RECORD=1 bun test src/handlers/eval/config-bundle/config-bundle.fixture.test.tsx
function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

let bundleId: string;
let firstVersionId: string;
let secondVersionId: string;

afterAll(async () => {
  if (!isRecording() || !bundleId) return;

  const control = createControlClient({ region: REGION });
  try {
    await control.send(new GetConfigurationBundleCommand({ bundleId, branchName: "mainline" }));
    await control.send(new DeleteConfigurationBundleCommand({ bundleId }));
  } catch (error) {
    if ((error as Error).name !== "ResourceNotFoundException") {
      console.error(`could not clean up fixture configuration bundle ${bundleId}:`, error);
    }
  }
});

describe("eval config-bundle against recorded responses", () => {
  test("creates a configuration bundle", async () => {
    const stdout = await run([
      "eval",
      "config-bundle",
      "create",
      "--name",
      BUNDLE_NAME,
      "--components",
      JSON.stringify(COMPONENTS_V1),
    ]);

    matchGolden(FIXTURES, "config-bundle-create.golden.json", stdout);
    const response = JSON.parse(stdout);
    bundleId = response.bundleId;
    firstVersionId = response.versionId;
    expect(bundleId).toBeString();
    expect(firstVersionId).toBeString();
  });

  test("gets the latest mainline version", async () => {
    await settle();

    const stdout = await run(["eval", "config-bundle", "get", "--id", bundleId]);

    matchGolden(FIXTURES, "config-bundle-get-latest.golden.json", stdout);
    const response = JSON.parse(stdout);
    expect(response.versionId).toBe(firstVersionId);
    expect(response.components).toEqual(COMPONENTS_V1);
    expect(response.lineageMetadata.branchName).toBe("mainline");
  }, 60_000);

  test("gets the initial immutable version", async () => {
    const stdout = await run([
      "eval",
      "config-bundle",
      "get",
      "--id",
      bundleId,
      "--version",
      firstVersionId,
    ]);

    matchGolden(FIXTURES, "config-bundle-get-v1.golden.json", stdout);
    expect(JSON.parse(stdout).components).toEqual(COMPONENTS_V1);
  });

  test("lists configuration bundles", async () => {
    const stdout = await run(["eval", "config-bundle", "list", "--json"]);

    matchGolden(FIXTURES, "config-bundle-list.golden.json", stdout);
    expect(JSON.parse(stdout).bundles).toEqual(
      expect.arrayContaining([expect.objectContaining({ bundleId })]),
    );
  });

  test("updates from the latest mainline parent", async () => {
    const stdout = await run([
      "eval",
      "config-bundle",
      "update",
      "--id",
      bundleId,
      "--components",
      JSON.stringify(COMPONENTS_V2),
      "--commit-message",
      "Record configuration bundle fixture version two",
    ]);

    matchGolden(FIXTURES, "config-bundle-update.golden.json", stdout);
    const response = JSON.parse(stdout);
    secondVersionId = response.versionId;
    expect(secondVersionId).toBeString();
    expect(secondVersionId).not.toBe(firstVersionId);
  });

  test("gets the updated immutable version", async () => {
    await settle();

    const stdout = await run([
      "eval",
      "config-bundle",
      "get",
      "--id",
      bundleId,
      "--version",
      secondVersionId,
    ]);

    matchGolden(FIXTURES, "config-bundle-get-v2.golden.json", stdout);
    const response = JSON.parse(stdout);
    expect(response.components).toEqual(COMPONENTS_V2);
    expect(response.lineageMetadata.parentVersionIds).toEqual([firstVersionId]);
    expect(response.lineageMetadata.commitMessage).toBe(
      "Record configuration bundle fixture version two",
    );
  }, 60_000);

  test("lists both immutable versions", async () => {
    const stdout = await run(["eval", "config-bundle", "version", "list", "--id", bundleId]);

    matchGolden(FIXTURES, "config-bundle-version-list.golden.json", stdout);
    expect(
      JSON.parse(stdout).versions.map((version: { versionId: string }) => version.versionId),
    ).toEqual(expect.arrayContaining([firstVersionId, secondVersionId]));
  });

  test("deletes the configuration bundle", async () => {
    const stdout = await run(["eval", "config-bundle", "delete", "--id", bundleId]);

    matchGolden(FIXTURES, "config-bundle-delete.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({ bundleId, status: "DELETING" });
  });
});
