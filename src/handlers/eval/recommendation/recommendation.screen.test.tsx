import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetRecommendationResponse,
  RecommendationSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

const evalEndpointUrl = "https://eval.test";

function summary(overrides: Partial<RecommendationSummary> = {}): RecommendationSummary {
  return {
    recommendationArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:recommendation/rec-1",
    recommendationId: "rec-1",
    name: "prompt_tuning",
    type: "SYSTEM_PROMPT_RECOMMENDATION",
    status: "COMPLETED",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function coreWith(items: RecommendationSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setListRecommendationsResponse({ recommendationSummaries: items });
  return core;
}

describe("recommendation menu", () => {
  test("offers get and list", async () => {
    const screen = renderScreen("/agentcore/eval/recommendation");
    await waitForText(screen.lastFrame, "list recommendations");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).toContain("get");
  });
});

describe("recommendation picker", () => {
  test("renders name, type, status, and updated time", async () => {
    const core = coreWith([
      summary({
        name: "staging_rec",
        type: "TOOL_DESCRIPTION_RECOMMENDATION",
        status: "FAILED",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/recommendation/list", { core });

    await waitForText(screen.lastFrame, "staging_rec");
    const frame = screen.lastFrame()!;
    // The `_RECOMMENDATION` suffix is stripped so the verbose enum fits the column.
    expect(frame).toContain("TOOL_DESCRIPTION");
    expect(frame).not.toContain("TOOL_DESCRIPTION_RECOMMENDATION");
    expect(frame).toContain("FAILED");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("calls listRecommendations with exact Core options and no status filter", async () => {
    const core = coreWith([summary()]);
    renderScreen("/agentcore/eval/recommendation/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() => core.eval.calls.some((c) => c.method === "listRecommendations"));
    expect(core.eval.calls.filter((c) => c.method === "listRecommendations")).toEqual([
      {
        method: "listRecommendations",
        args: [
          undefined,
          expect.any(Number),
          undefined,
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("falls back to id and dashes when summary fields are missing", async () => {
    const core = coreWith([
      // Only an id — every other display field absent.
      { recommendationId: "rec-bare" } as RecommendationSummary,
    ]);
    const screen = renderScreen("/agentcore/eval/recommendation/list", { core });

    await waitForText(screen.lastFrame, "rec-bare");
    expect(screen.lastFrame()).toContain("-");
  });

  test("bare get redirects to the picker", async () => {
    const core = coreWith([summary({ recommendationId: "redirected", name: "redirected_rec" })]);
    const screen = renderScreen("/agentcore/eval/recommendation/get", { core });

    await waitForText(screen.lastFrame, "redirected_rec");
    expect(core.eval.calls[0]?.method).toBe("listRecommendations");
  });

  test("selection opens the matching recommendation JSON", async () => {
    const core = coreWith([summary({ recommendationId: "rec-1" })]);
    core.eval.setGetRecommendationResponse({
      recommendationId: "rec-1",
      name: "prompt_tuning",
    } as GetRecommendationResponse);
    const screen = renderScreen("/agentcore/eval/recommendation/list", { core });

    await waitForText(screen.lastFrame, "prompt_tuning");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → recommendation → get → rec-1");
    await waitFor(() =>
      core.eval.calls.some((c) => c.method === "getRecommendation" && c.args[0] === "rec-1"),
    );
  });

  test("shows the empty state", async () => {
    const empty = renderScreen("/agentcore/eval/recommendation/list");
    await waitForText(empty.lastFrame, "No recommendations found in this Region.");
  });
});

describe("recommendation detail (raw JSON)", () => {
  test("renders the full response", async () => {
    const core = new TestCoreClient();
    core.eval.setGetRecommendationResponse({
      recommendationId: "rec-1",
      name: "prompt_tuning",
      status: "COMPLETED",
    } as GetRecommendationResponse);
    const screen = renderScreen("/agentcore/eval/recommendation/get/rec-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "prompt_tuning");
    const frame = screen.lastFrame()!;
    expect(frame).toContain('"status"');
    expect(frame).toContain("COMPLETED");
    expect(core.eval.calls.find((c) => c.method === "getRecommendation")).toEqual({
      method: "getRecommendation",
      args: ["rec-1", { region: "us-east-1", endpointUrl: evalEndpointUrl }],
    });
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("recommendation unavailable"));
    const screen = renderScreen("/agentcore/eval/recommendation/get/rec-1", { core });

    await waitForText(screen.lastFrame, "recommendation unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setGetRecommendationResponse({
      recommendationId: "rec-1",
      name: "prompt_tuning",
    } as GetRecommendationResponse);
    await screen.write("r");
    await waitForText(screen.lastFrame, "prompt_tuning");
  });
});
