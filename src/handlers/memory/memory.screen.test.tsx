import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetMemoryOutput,
  Memory,
  MemorySummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { QueryClient } from "@tanstack/react-query";
import stringWidth from "string-width";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  tick,
  waitFor,
  waitForText,
} from "../../testing";

afterEach(cleanupScreens);

const memoryEndpointUrl = "https://memory.test";

function memorySummary(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/memory-1",
    id: "memory-1",
    status: "ACTIVE",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/memory-1",
    id: "memory-1",
    name: "orders-memory",
    description: "Memory for the orders agent",
    memoryExecutionRoleArn: "arn:aws:iam::123456789012:role/memory-role",
    eventExpiryDuration: 30,
    status: "ACTIVE",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    strategies: [
      {
        strategyId: "summary-1",
        name: "summary",
        type: "SUMMARIZATION",
        namespaces: [],
        namespaceTemplates: ["/strategies/{memoryStrategyId}/actors/{actorId}"],
        status: "ACTIVE",
      },
    ],
    ...overrides,
  };
}

function getMemoryOutput(overrides: Partial<Memory> = {}): GetMemoryOutput {
  return { memory: memory(overrides) };
}

function coreWithMemories(memories: MemorySummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.memory.setListResponse({ memories });
  return core;
}

describe("Memory picker", () => {
  test("shows event, record, actor, and session commands in the Memory TUI menu", async () => {
    const screen = renderScreen("/agentcore/memory");

    await waitForText(screen.lastFrame, "inspect AgentCore Memories");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("get");
    expect(frame).toContain("list");
    expect(frame).toContain("event");
    expect(frame).toContain("record");
    expect(frame).toContain("actor");
    expect(frame).toContain("session");
  });

  test("renders Memory identity, status, and update time", async () => {
    const core = coreWithMemories([
      memorySummary({
        id: "memory-visible-id",
        status: "FAILED",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/memory/list", { core });

    await waitForText(screen.lastFrame, "memory-visible-id");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("ID");
    expect(frame).toContain("status");
    expect(frame).toContain("updated UTC");
    expect(frame).toContain("FAILED");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("keeps long Memory IDs separate from adjacent columns", async () => {
    const memoryId = `memory-${"x".repeat(70)}`;
    const core = coreWithMemories([memorySummary({ id: memoryId })]);
    const screen = renderScreen("/agentcore/memory/list", { core });

    await waitForText(screen.lastFrame, "memory-");
    await screen.resize(80, 24);
    const row = screen
      .lastFrame()!
      .split("\n")
      .find((line) => line.includes("memory-"));
    expect(row).toBeDefined();
    expect(row).toContain("ACTIVE");
    expect(row).not.toContain(memoryId);
    expect(stringWidth(row!)).toBeLessThanOrEqual(80);
  });

  test("calls listMemories with exact Core options", async () => {
    const core = coreWithMemories([memorySummary()]);
    renderScreen("/agentcore/memory/list", { core, endpointUrl: memoryEndpointUrl });

    await waitFor(() => core.memory.calls.some((call) => call.method === "listMemories"));
    expect(core.memory.calls.filter((call) => call.method === "listMemories")).toEqual([
      {
        method: "listMemories",
        args: [
          undefined,
          expect.any(Number),
          {
            region: "us-east-1",
            endpointUrl: memoryEndpointUrl,
          },
        ],
      },
    ]);
  });

  test("shows first-page and later-page empty states", async () => {
    const empty = renderScreen("/agentcore/memory/list");
    await waitForText(empty.lastFrame, "No Memories found in this Region.");
    empty.unmount();

    const core = new TestCoreClient();
    core.memory.setListResponse({
      memories: [memorySummary({ id: "page-one" })],
      nextToken: "page-2",
    });
    core.memory.setListResponse({ memories: [] }, "page-2");
    const paged = renderScreen("/agentcore/memory/list", { core });

    await waitForText(paged.lastFrame, "page 1 · more →");
    await paged.write("l");
    await waitForText(paged.lastFrame, "No Memories on this page.");
    expect(paged.lastFrame()).not.toContain("No Memories found in this Region.");
  });

  test("bare Memory get redirects to the picker", async () => {
    const core = coreWithMemories([memorySummary({ id: "redirected-memory" })]);
    const screen = renderScreen("/agentcore/memory/get", { core });

    await waitForText(screen.lastFrame, "redirected-memory");
    expect(core.memory.calls[0]?.method).toBe("listMemories");
  });

  test("selection opens the matching Memory detail", async () => {
    const memoryId = "memory blue";
    const core = coreWithMemories([memorySummary({ id: memoryId })]);
    core.memory.setGetResponse(getMemoryOutput({ id: memoryId }));
    const screen = renderScreen("/agentcore/memory/list", { core });

    await waitForText(screen.lastFrame, memoryId);
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → memory → get → ${memoryId}`);
    await waitFor(() =>
      core.memory.calls.some((call) => call.method === "getMemory" && call.args[0] === memoryId),
    );
  });
});

describe("Memory detail", () => {
  test("loads the full view and renders a resource summary", async () => {
    const core = new TestCoreClient();
    core.memory.setGetResponse(getMemoryOutput());
    const screen = renderScreen("/agentcore/memory/get/memory-1", {
      core,
      endpointUrl: memoryEndpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("orders-memory");
    expect(frame).toMatch(/eventExpiryDays\s+30/);
    expect(frame).toMatch(/strategies\s+1/);
    expect(frame).toContain("arn:aws:bedrock-agentcore");
    expect(frame).toContain("list this Memory's actors");
    expect(frame).toContain("choose an actor to list this Memory's sessions");
    expect(core.memory.calls.find((call) => call.method === "getMemory")).toEqual({
      method: "getMemory",
      args: [
        "memory-1",
        "full",
        {
          region: "us-east-1",
          endpointUrl: memoryEndpointUrl,
        },
      ],
    });
  });

  test("shows a failure reason only when the service provides one", async () => {
    const healthyCore = new TestCoreClient();
    healthyCore.memory.setGetResponse(getMemoryOutput());
    const healthy = renderScreen("/agentcore/memory/get/memory-1", { core: healthyCore });

    await waitForText(healthy.lastFrame, "show the full JSON definition");
    expect(healthy.lastFrame()).not.toContain("failureReason");
    healthy.unmount();

    const failedCore = new TestCoreClient();
    failedCore.memory.setGetResponse(
      getMemoryOutput({ status: "FAILED", failureReason: "Strategy setup failed" }),
    );
    const failed = renderScreen("/agentcore/memory/get/memory-1", { core: failedCore });

    await waitForText(failed.lastFrame, "Strategy setup failed");
    expect(failed.lastFrame()).toContain("failureReason");
  });

  test("opens the complete Memory JSON", async () => {
    const core = new TestCoreClient();
    core.memory.setGetResponse(getMemoryOutput());
    const screen = renderScreen("/agentcore/memory/get/memory-1", { core });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → memory → get → memory-1 → json");
    const frame = screen.lastFrame()!;
    expect(frame).toContain('"memoryExecutionRoleArn"');
    expect(frame).toContain('"strategies"');
  });

  test("unwinds the event flow from an empty actor picker through Memory detail to the list", async () => {
    const core = new TestCoreClient();
    core.memory.setListResponse({ memories: [memorySummary()] });
    core.memory.setGetResponse(getMemoryOutput());
    core.memory.setListActorsResponse({ actorSummaries: [] });
    const screen = renderScreen("/agentcore/memory/list", { core });

    await waitForText(screen.lastFrame, "memory-1");
    await screen.press("return");
    await waitForText(screen.lastFrame, "list this Memory's events");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "choose an actor to list sessions for");

    await waitFor(() => core.memory.calls.some((call) => call.method === "listActors"));
    expect(core.memory.calls.find((call) => call.method === "listActors")?.args[0]).toMatchObject({
      memoryId: "memory-1",
    });

    await screen.press("escape");
    await waitForText(screen.lastFrame, "list this Memory's events");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "updated UTC");
    expect(screen.lastFrame()).not.toContain("list this Memory's events");
  });

  test("unwinds the record flow through Memory detail to the list", async () => {
    const core = new TestCoreClient();
    core.memory.setListResponse({ memories: [memorySummary()] });
    core.memory.setGetResponse(getMemoryOutput());
    const screen = renderScreen("/agentcore/memory/list", { core });

    await waitForText(screen.lastFrame, "memory-1");
    await screen.press("return");
    await waitForText(screen.lastFrame, "list this Memory's records");
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "choose the namespace scope for the record list");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "list this Memory's records");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "updated UTC");
    expect(screen.lastFrame()).not.toContain("list this Memory's records");
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.memory.setError(new Error("memory unavailable"));
    const screen = renderScreen("/agentcore/memory/get/memory-1", { core });

    await waitForText(screen.lastFrame, "memory unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.memory.setError(undefined);
    core.memory.setGetResponse(getMemoryOutput());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("does not open cached detail after a background refresh fails", async () => {
    const core = new TestCoreClient();
    core.memory.setGetResponse(getMemoryOutput());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const screen = renderScreen("/agentcore/memory/get/memory-1", { core, queryClient });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    core.memory.setError(new Error("background refresh failed"));
    await queryClient.invalidateQueries({
      queryKey: ["memory", "us-east-1", "memory-1", "full"],
    });
    await waitForText(screen.lastFrame, "background refresh failed");

    await screen.press("return");
    await tick();
    expect(screen.lastFrame()).toContain("agentcore → memory → get → memory-1");
    expect(screen.lastFrame()).not.toContain("→ json");
  });

  // A hub reached with ?region= (from project status or a harness's linked
  // rows) fetches there; its actions must keep fetching there too.
  test("a hub opened with ?region= carries the region into its actor list", async () => {
    const core = new TestCoreClient();
    core.memory.setGetResponse(getMemoryOutput());
    core.memory.setListActorsResponse({ actorSummaries: [] });
    const screen = renderScreen("/agentcore/memory/get/memory-1?region=eu-west-1", { core });

    await waitForText(screen.lastFrame, "list this Memory's events");
    expect(core.memory.calls.find((call) => call.method === "getMemory")?.args[2]).toMatchObject({
      region: "eu-west-1",
    });

    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "choose an actor to list sessions for");
    await waitFor(() => core.memory.calls.some((call) => call.method === "listActors"));
    expect(core.memory.calls.find((call) => call.method === "listActors")?.args[1]).toMatchObject({
      region: "eu-west-1",
    });
  });
});
