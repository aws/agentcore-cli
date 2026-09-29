import { afterEach, describe, expect, test } from "bun:test";
import type { ActorSummary, SessionSummary } from "@aws-sdk/client-bedrock-agentcore";
import type { MemorySummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

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

function actor(overrides: Partial<ActorSummary> = {}): ActorSummary {
  return {
    actorId: "actor-1",
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    actorId: "actor-1",
    createdAt: new Date("2026-08-02T10:20:30.000Z"),
    ...overrides,
  };
}

describe("Memory actor list flow", () => {
  test("uses the Memory picker, lists actors, then opens the actor's sessions", async () => {
    const memoryId = "memory/blue one";
    const actorId = "actor/blue one";
    const core = new TestCoreClient();
    core.memory.setListResponse({ memories: [memorySummary({ id: memoryId })] });
    core.memory.setListActorsResponse({ actorSummaries: [actor({ actorId })] });
    core.memory.setListSessionsResponse({
      sessionSummaries: [session({ actorId })],
    });
    const screen = renderScreen("/agentcore/memory/actor/list", { core });

    await waitForText(screen.lastFrame, memoryId);
    await screen.press("return");
    await waitForText(screen.lastFrame, actorId);
    await screen.press("return");
    await waitForText(screen.lastFrame, "session-1");

    expect(core.memory.calls.find((call) => call.method === "listActors")).toEqual({
      method: "listActors",
      args: [
        {
          memoryId,
          maxResults: expect.any(Number),
          nextToken: undefined,
        },
        { region: "us-east-1" },
      ],
    });
    expect(core.memory.calls.find((call) => call.method === "listSessions")).toEqual({
      method: "listSessions",
      args: [
        {
          memoryId,
          actorId,
          maxResults: expect.any(Number),
          nextToken: undefined,
        },
        { region: "us-east-1" },
      ],
    });

    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose an actor to list sessions for");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Memory to list actors for");
  });

  test("shows empty and retry states for actor lists", async () => {
    const empty = renderScreen("/agentcore/memory/actor/list/memory-1");
    await waitForText(empty.lastFrame, "No actors found for Memory memory-1.");
    empty.unmount();

    const core = new TestCoreClient();
    core.memory.setError(new Error("actors unavailable"));
    const failed = renderScreen("/agentcore/memory/actor/list/memory-1", { core });

    await waitForText(failed.lastFrame, "actors unavailable");
    core.memory.setError(undefined);
    core.memory.setListActorsResponse({ actorSummaries: [actor()] });
    await failed.write("r");
    await waitFor(() => failed.lastFrame()?.includes("actor-1") ?? false);
  });
});
