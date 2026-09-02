import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
  uniquePerRecording,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__", "policy");
const GATEWAY_ID = "policygene2e-tools-zhijfh6m5z";
const GATEWAY_ARN = `arn:aws:bedrock-agentcore:us-west-2:887863153624:gateway/${GATEWAY_ID}`;
const ENGINE_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:887863153624:policy-engine/PolicyGenE2E_Guardrails-gn5jf72o3t";
const BARE_GATEWAY_ID = "policygene2e-bare-xl0dy3pq5h";
const RECORD_TIMEOUT = 600_000;

// Generation names are unique per engine on the service, so each recording needs
// fresh ones while replays reuse the recorded set.
const NAMES = uniquePerRecording(FIXTURES, "generation-names", () => {
  const stamp = Date.now();
  return {
    forbid: `golden_forbid_${stamp}`,
    permit: `golden_permit_${stamp}`,
    missingEngine: `golden_missing_engine_${stamp}`,
    untranslatable: `golden_untranslatable_${stamp}`,
  };
});

// The fixture graph is the deployed `PolicyGenE2E` project: Gateway `tools` with
// Policy Engine `Guardrails` attached, and Gateway `bare` with no engine. Record with:
// RECORD=1 bun test src/handlers/gateway/gateway.policy.test.tsx
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

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route([
    "node",
    "agentcore",
    "gateway",
    "policy",
    "generate",
    ...args,
    "--region",
    REGION,
  ]);
  return { stdout: io.stdout(), stderr: io.stderr() };
}

describe("gateway policy generate fixture-backed flows", () => {
  test(
    "prints the Cedar on stdout and the findings on stderr with the attached engine",
    async () => {
      const { stdout, stderr } = await run([
        "--gateway-id",
        GATEWAY_ID,
        "--prompt",
        "forbid IAM principals from calling any tool on this gateway",
        "--name",
        NAMES.forbid,
      ]);
      matchGolden(FIXTURES, "generate.golden.cedar", stdout);
      matchGolden(FIXTURES, "generate.golden.stderr", stderr);
      expect(stdout).toContain(`resource == AgentCore::Gateway::"${GATEWAY_ARN}"`);
    },
    RECORD_TIMEOUT,
  );

  test(
    "prints the result object with --json for an ARN and an explicit engine ARN",
    async () => {
      const { stdout } = await run([
        "--gateway-id",
        GATEWAY_ARN,
        "--policy-engine-id",
        ENGINE_ARN,
        "--prompt",
        "permit IAM principals to call any tool on this gateway",
        "--name",
        NAMES.permit,
        "--json",
      ]);
      matchGolden(FIXTURES, "generate-json.golden.json", stdout);
      expect(JSON.parse(stdout)).toMatchObject({
        policyEngineId: "PolicyGenE2E_Guardrails-gn5jf72o3t",
        gatewayArn: GATEWAY_ARN,
      });
    },
    RECORD_TIMEOUT,
  );

  test.each([
    [
      "the gateway has no engine attached",
      ["--gateway-id", BARE_GATEWAY_ID, "--prompt", "forbid everything"],
      /has no Policy Engine attached; pass --policy-engine-id/,
    ],
    [
      "the explicit engine does not exist",
      [
        "--gateway-id",
        GATEWAY_ID,
        "--policy-engine-id",
        "pe-does-not-exist",
        "--prompt",
        "forbid everything",
        "--name",
        NAMES.missingEngine,
      ],
      /policyEngineId/,
    ],
    [
      "the prompt cannot be translated",
      [
        "--gateway-id",
        GATEWAY_ID,
        "--prompt",
        "permit everyone to list tools but forbid calling any tool whose name contains delete",
        "--name",
        NAMES.untranslatable,
      ],
      /could not be translated into a Cedar policy: \[INVALID\]/,
    ],
  ])(
    "fails when %s",
    async (_label, args, message) => {
      await expect(run(args)).rejects.toThrow(message);
    },
    RECORD_TIMEOUT,
  );
});
