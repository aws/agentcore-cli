import { describe, expect, test } from "bun:test";
import type {
  DeleteRecommendationResponse,
  GetRecommendationResponse,
  ListRecommendationsResponse,
  RecommendationConfig,
  StartRecommendationResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const ENDPOINT = "https://agentcore.example.test";
const CONFIG: RecommendationConfig = {
  systemPromptRecommendationConfig: {
    systemPrompt: { text: "You are a support agent." },
    agentTraces: {
      sessionSpans: [{ traceId: "trace-1", spanId: "span-1" }],
    },
    evaluationConfig: {
      evaluators: [
        {
          evaluatorArn:
            "arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/Builtin.Helpfulness",
        },
      ],
    },
  },
};

function testRecommendationCommand(stdin?: string) {
  const core = new TestCoreClient();
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    stdout: io.stdout,
    route: (args: string[]) => root.route(["bun", "agentcore", ...args, "--region", REGION]),
    root,
  };
}

function callArgs(core: TestCoreClient, method: string): unknown[] {
  const call = core.eval.calls.find((candidate) => candidate.method === method);
  if (!call) throw new Error(`${method} was not called`);
  return call.args;
}

describe("eval recommendation command hierarchy", () => {
  test("registers the imperative API commands and flags", () => {
    const { root } = testRecommendationCommand();
    const recommendation = root
      .children()
      .find((child) => child.name() === "eval")
      ?.children()
      .find((child) => child.name() === "recommendation");

    expect(recommendation?.children().map((child) => child.name())).toEqual([
      "start",
      "get",
      "list",
      "delete",
    ]);

    const start = recommendation?.children().find((child) => child.name() === "start");
    expect(start?.flags().map((candidate) => candidate.name)).toEqual([
      "name",
      "type",
      "recommendation-config",
      "description",
      "kms-key-arn",
      "tags",
    ]);
    expect(
      start?.flags().find((candidate) => candidate.name === "recommendation-config")?.sensitive,
    ).toBe(true);
    expect(
      recommendation
        ?.children()
        .find((child) => child.name() === "list")
        ?.flags()
        .map((candidate) => candidate.name),
    ).toEqual(["next-token", "max-results", "status-filter"]);
  });
});

describe("recommendation start", () => {
  test("maps the complete API request, tags, Core options, and response", async () => {
    const { core, stdout, route } = testRecommendationCommand();
    const response = {
      recommendationId: "recommendation-1",
      recommendationArn: "arn:recommendation-1",
      name: "support-prompt",
      type: "SYSTEM_PROMPT_RECOMMENDATION",
      status: "PENDING",
      createdAt: new Date("2026-08-26T12:00:00.000Z"),
      updatedAt: new Date("2026-08-26T12:00:00.000Z"),
    } as StartRecommendationResponse;
    core.eval.setStartRecommendationResponse(response);

    await route([
      "eval",
      "recommendation",
      "start",
      "--name",
      "support-prompt",
      "--type",
      "SYSTEM_PROMPT_RECOMMENDATION",
      "--recommendation-config",
      JSON.stringify(CONFIG),
      "--description",
      "Improve the support prompt",
      "--kms-key-arn",
      "arn:aws:kms:us-west-2:123456789012:key/recommendations",
      "--tags",
      "environment=test",
      "--tags",
      "team=eval",
      "--endpoint-url",
      ENDPOINT,
    ]);

    expect(callArgs(core, "startRecommendation")).toEqual([
      {
        name: "support-prompt",
        type: "SYSTEM_PROMPT_RECOMMENDATION",
        recommendationConfig: CONFIG,
        description: "Improve the support prompt",
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/recommendations",
        tags: { environment: "test", team: "eval" },
      },
      { region: REGION, endpointUrl: ENDPOINT },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      ...response,
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
    });
  });

  test("resolves recommendation config from stdin", async () => {
    const { core, route } = testRecommendationCommand(JSON.stringify(CONFIG));

    await route([
      "eval",
      "recommendation",
      "start",
      "--name",
      "support-prompt",
      "--type",
      "SYSTEM_PROMPT_RECOMMENDATION",
      "--recommendation-config",
      "-",
    ]);

    expect(callArgs(core, "startRecommendation")[0]).toMatchObject({
      recommendationConfig: CONFIG,
    });
  });

  test("rejects malformed config JSON before calling Core", async () => {
    const { core, route } = testRecommendationCommand();

    await expect(
      route([
        "eval",
        "recommendation",
        "start",
        "--name",
        "support-prompt",
        "--type",
        "SYSTEM_PROMPT_RECOMMENDATION",
        "--recommendation-config",
        "{not-json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--recommendation-config'/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("recommendation get, list, and delete", () => {
  test("gets by id and renders the API response unchanged", async () => {
    const { core, stdout, route } = testRecommendationCommand();
    const response = {
      recommendationId: "recommendation-1",
      name: "support-prompt",
      type: "SYSTEM_PROMPT_RECOMMENDATION",
      recommendationConfig: CONFIG,
      status: "COMPLETED",
      createdAt: new Date("2026-08-26T12:00:00.000Z"),
      updatedAt: new Date("2026-08-26T12:05:00.000Z"),
    } as GetRecommendationResponse;
    core.eval.setGetRecommendationResponse(response);

    await route(["eval", "recommendation", "get", "--id", "recommendation-1"]);

    expect(callArgs(core, "getRecommendation")).toEqual([
      "recommendation-1",
      { region: REGION, endpointUrl: undefined },
    ]);
    expect(JSON.parse(stdout()).recommendationId).toBe("recommendation-1");
    expect(JSON.parse(stdout()).recommendationConfig).toEqual(CONFIG);
  });

  test("passes pagination and status filtering and renders the response", async () => {
    const { core, stdout, route } = testRecommendationCommand();
    const response = {
      recommendationSummaries: [
        {
          recommendationId: "recommendation-2",
          recommendationArn: "arn:recommendation-2",
          name: "tool-descriptions",
          type: "TOOL_DESCRIPTION_RECOMMENDATION",
          status: "IN_PROGRESS",
          createdAt: new Date("2026-08-26T13:00:00.000Z"),
          updatedAt: new Date("2026-08-26T13:01:00.000Z"),
        },
      ],
      nextToken: "token-2",
    } as ListRecommendationsResponse;
    core.eval.setListRecommendationsResponse(response, "token-1");

    await route([
      "eval",
      "recommendation",
      "list",
      "--next-token",
      "token-1",
      "--max-results",
      "5",
      "--status-filter",
      "IN_PROGRESS",
    ]);

    expect(callArgs(core, "listRecommendations")).toEqual([
      "token-1",
      5,
      "IN_PROGRESS",
      { region: REGION, endpointUrl: undefined },
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      recommendationSummaries: [{ recommendationId: "recommendation-2" }],
      nextToken: "token-2",
    });
  });

  test("deletes by id and renders the API response", async () => {
    const { core, stdout, route } = testRecommendationCommand();
    const response = {
      recommendationId: "recommendation-1",
      status: "DELETING",
    } as DeleteRecommendationResponse;
    core.eval.setDeleteRecommendationResponse(response);

    await route(["eval", "recommendation", "delete", "--id", "recommendation-1"]);

    expect(callArgs(core, "deleteRecommendation")).toEqual([
      "recommendation-1",
      { region: REGION, endpointUrl: undefined },
    ]);
    expect(JSON.parse(stdout())).toEqual(response);
  });
});

describe("recommendation flag validation", () => {
  test.each([
    [["eval", "recommendation", "start"], /--name/],
    [
      [
        "eval",
        "recommendation",
        "start",
        "--name",
        "support-prompt",
        "--recommendation-config",
        JSON.stringify(CONFIG),
      ],
      /--type/,
    ],
    [
      [
        "eval",
        "recommendation",
        "start",
        "--name",
        "support-prompt",
        "--type",
        "SYSTEM_PROMPT_RECOMMENDATION",
      ],
      /--recommendation-config/,
    ],
    [["eval", "recommendation", "get"], /--id/],
    [["eval", "recommendation", "delete"], /--id/],
  ] as const)("requires API-mandated flags for %p", async (args, expected) => {
    const { core, route } = testRecommendationCommand();

    await expect(route([...args])).rejects.toThrow(expected);
    expect(core.eval.calls).toHaveLength(0);
  });

  test.each([
    [["--type", "FUTURE_RECOMMENDATION"], /--type/],
    [["--status-filter", "CANCELLED"], /--status-filter/],
  ] as const)("rejects unsupported enum input %p", async ([flag, value], expected) => {
    const { core, route } = testRecommendationCommand();
    const base =
      flag === "--type"
        ? [
            "eval",
            "recommendation",
            "start",
            "--name",
            "support-prompt",
            "--recommendation-config",
            JSON.stringify(CONFIG),
          ]
        : ["eval", "recommendation", "list"];

    await expect(route([...base, flag, value])).rejects.toThrow(expected);
    expect(core.eval.calls).toHaveLength(0);
  });
});
