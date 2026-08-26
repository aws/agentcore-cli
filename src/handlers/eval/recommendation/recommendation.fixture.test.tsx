import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteRecommendationCommand,
  GetRecommendationCommand,
  ListRecommendationsCommand,
  type BedrockAgentCoreClient,
  type RecommendationConfig,
  type RecommendationStatus,
} from "@aws-sdk/client-bedrock-agentcore";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import { createDataClient } from "../../../core/factories";
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
const RECOMMENDATION_NAME = "agentcore_cli_recommendation_fixture";
const RECORDING_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const CONFIG: RecommendationConfig = {
  systemPromptRecommendationConfig: {
    systemPrompt: {
      text: "You are a concise support assistant. Answer the user's question directly.",
    },
    agentTraces: {
      sessionSpans: [
        {
          resource: {
            attributes: {
              "service.name": "agentcore-cli-fixture",
              "aws.service.type": "gen_ai_agent",
            },
          },
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "0123456789abcdef",
          flags: 256,
          name: "invoke_agent AgentCore CLI fixture",
          kind: "INTERNAL",
          startTimeUnixNano: 1_750_000_000_000_000_000,
          endTimeUnixNano: 1_750_000_001_000_000_000,
          durationNano: 1_000_000_000,
          scope: { name: "agentcore-cli-fixture" },
          attributes: {
            "session.id": "00000000-0000-4000-8000-000000000001",
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": "AgentCore CLI fixture",
            "gen_ai.system": "strands-agents",
            "aws.genai.span_kind": "AGENT",
          },
          status: { code: "OK" },
          body: {
            input: {
              messages: [{ role: "user", content: [{ text: "What is two plus two?" }] }],
            },
            output: {
              messages: [{ role: "assistant", content: [{ text: "Two plus two is four." }] }],
            },
          },
        },
      ],
    },
    evaluationConfig: {
      evaluators: [
        {
          evaluatorArn: "arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness",
        },
      ],
    },
  },
};

// Record with:
// RECORD=1 bun test src/handlers/eval/recommendation/recommendation.fixture.test.tsx
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

  await root.route(["bun", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

let recommendationId: string | undefined;
let deleted = false;

function requireRecommendationId(): string {
  if (!recommendationId) {
    throw new Error("start fixture did not return a recommendation id");
  }
  return recommendationId;
}

function isNotFound(error: unknown): boolean {
  return (error as Error).name === "ResourceNotFoundException";
}

async function waitForTerminal(
  client: BedrockAgentCoreClient,
  id: string,
): Promise<RecommendationStatus | undefined> {
  const deadline = Date.now() + RECORDING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await client.send(new GetRecommendationCommand({ recommendationId: id }));
    if (response.status === "COMPLETED" || response.status === "FAILED") {
      return response.status;
    }
    if (response.status === "DELETING") return response.status;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for recommendation ${id} to reach a terminal state`);
}

async function waitUntilDeleted(client: BedrockAgentCoreClient, id: string): Promise<void> {
  const deadline = Date.now() + RECORDING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await client.send(new GetRecommendationCommand({ recommendationId: id }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for recommendation ${id} to be deleted`);
}

async function cleanupRecommendation(client: BedrockAgentCoreClient, id: string): Promise<void> {
  let status: RecommendationStatus | undefined;
  try {
    status = (await client.send(new GetRecommendationCommand({ recommendationId: id }))).status;
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  if (status === "PENDING" || status === "IN_PROGRESS") {
    status = await waitForTerminal(client, id);
  }
  if (status !== "DELETING") {
    await client.send(new DeleteRecommendationCommand({ recommendationId: id }));
  }
  await waitUntilDeleted(client, id);
}

beforeAll(async () => {
  if (!isRecording()) return;

  const client = createDataClient({ region: REGION });
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListRecommendationsCommand({ maxResults: 100, nextToken }));
    ids.push(
      ...(page.recommendationSummaries ?? [])
        .filter((summary) => summary.name === RECOMMENDATION_NAME)
        .flatMap((summary) => (summary.recommendationId ? [summary.recommendationId] : [])),
    );
    nextToken = page.nextToken;
  } while (nextToken);

  for (const id of ids) await cleanupRecommendation(client, id);
}, RECORDING_TIMEOUT_MS);

afterAll(async () => {
  if (!isRecording() || !recommendationId || deleted) return;

  try {
    await cleanupRecommendation(createDataClient({ region: REGION }), recommendationId);
  } catch (error) {
    if (!isNotFound(error)) {
      console.error(`could not clean up fixture recommendation ${recommendationId}:`, error);
    }
  }
}, RECORDING_TIMEOUT_MS);

describe("eval recommendation against recorded responses", () => {
  test("starts a recommendation", async () => {
    const stdout = await run([
      "eval",
      "recommendation",
      "start",
      "--name",
      RECOMMENDATION_NAME,
      "--description",
      "Golden recommendation fixture",
      "--type",
      "SYSTEM_PROMPT_RECOMMENDATION",
      "--recommendation-config",
      JSON.stringify(CONFIG),
      "--tags",
      "suite=golden",
    ]);

    matchGolden(FIXTURES, "start.golden.json", stdout);
    const response = JSON.parse(stdout);
    recommendationId = response.recommendationId;
    expect(recommendationId).toBeString();
    expect(response.name).toBe(RECOMMENDATION_NAME);
    expect(response.type).toBe("SYSTEM_PROMPT_RECOMMENDATION");
  });

  test("gets the recommendation", async () => {
    await settle(2_000);
    const id = requireRecommendationId();

    const stdout = await run(["eval", "recommendation", "get", "--id", id]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    const response = JSON.parse(stdout);
    expect(response.recommendationId).toBe(id);
    expect(response.name).toBe(RECOMMENDATION_NAME);
    expect(response.recommendationConfig).toEqual(CONFIG);
  }, 60_000);

  test("lists recommendations with API pagination and filtering", async () => {
    const stdout = await run([
      "eval",
      "recommendation",
      "list",
      "--max-results",
      "5",
      "--status-filter",
      "COMPLETED",
    ]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).recommendationSummaries).toBeArray();
  });

  test(
    "deletes the recommendation",
    async () => {
      const id = requireRecommendationId();
      if (isRecording()) {
        await waitForTerminal(createDataClient({ region: REGION }), id);
      }

      const stdout = await run(["eval", "recommendation", "delete", "--id", id]);

      matchGolden(FIXTURES, "delete.golden.json", stdout);
      expect(JSON.parse(stdout)).toMatchObject({
        recommendationId: id,
        status: "DELETING",
      });
      deleted = true;
    },
    RECORDING_TIMEOUT_MS,
  );
});
