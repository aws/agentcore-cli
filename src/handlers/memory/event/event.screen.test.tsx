import { afterEach, describe, expect, test } from "bun:test";
import type { ActorSummary, Event, SessionSummary } from "@aws-sdk/client-bedrock-agentcore";
import type { MemorySummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

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

function event(overrides: Partial<Event> = {}): Event {
  return {
    memoryId: "memory-1",
    actorId: "actor-1",
    sessionId: "session-1",
    eventId: "event-1",
    eventTimestamp: new Date("2026-08-03T12:34:56.000Z"),
    payload: [],
    branch: { name: "main" },
    ...overrides,
  };
}

describe("Memory event list flow", () => {
  test("walks through Memory, actor, and session pickers before listing events", async () => {
    const memoryId = "memory/blue one";
    const actorId = "actor/blue one";
    const sessionId = "session/blue one";
    const core = new TestCoreClient();
    core.memory.setListResponse({ memories: [memorySummary({ id: memoryId })] });
    core.memory.setListActorsResponse({ actorSummaries: [actor({ actorId })] });
    core.memory.setListSessionsResponse({
      sessionSummaries: [session({ actorId, sessionId })],
    });
    core.memory.setListEventsResponse({
      events: [event({ memoryId, actorId, sessionId })],
    });
    const screen = renderScreen("/agentcore/memory/event/list", { core });

    await waitForText(screen.lastFrame, memoryId);
    await screen.press("return");
    await waitForText(screen.lastFrame, actorId);
    await screen.press("return");
    await waitForText(screen.lastFrame, sessionId);
    await screen.press("return");
    await waitForText(screen.lastFrame, "event-1");

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
    await waitForText(screen.lastFrame, "choose a session to list");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose an actor to list");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Memory to list");
  });

  test("calls listEvents with the exact route scope and Core options", async () => {
    const core = new TestCoreClient();
    core.memory.setListEventsResponse({ events: [event()] });
    renderScreen("/agentcore/memory/event/list/memory-1/actor-1/session-1", {
      core,
      endpointUrl: memoryEndpointUrl,
    });

    await waitFor(() => core.memory.calls.some((call) => call.method === "listEvents"));
    expect(core.memory.calls.filter((call) => call.method === "listEvents")).toEqual([
      {
        method: "listEvents",
        args: [
          {
            memoryId: "memory-1",
            actorId: "actor-1",
            sessionId: "session-1",
            maxResults: expect.any(Number),
            nextToken: undefined,
          },
          {
            region: "us-east-1",
            endpointUrl: memoryEndpointUrl,
          },
        ],
      },
    ]);
  });

  test("renders Event columns and opens the selected Event JSON", async () => {
    const core = new TestCoreClient();
    core.memory.setListEventsResponse({
      events: [event({ eventId: "event blue", metadata: { tenant: { stringValue: "acme" } } })],
    });
    core.memory.setGetEventResponse({
      event: event({
        eventId: "event blue",
        metadata: { tenant: { stringValue: "acme" } },
      }),
    });
    const screen = renderScreen("/agentcore/memory/event/list/memory-1/actor-1/session-1", {
      core,
    });

    await waitForText(screen.lastFrame, "event blue");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("event ID");
    expect(frame).toContain("branch");
    expect(frame).toContain("occurred UTC");
    expect(frame).toContain("main");
    expect(frame).toContain("2026-08-03 12:34");

    await screen.press("return");
    await waitForText(screen.lastFrame, '"tenant"');
    expect(core.memory.calls.find((call) => call.method === "getEvent")).toEqual({
      method: "getEvent",
      args: [
        {
          memoryId: "memory-1",
          actorId: "actor-1",
          sessionId: "session-1",
          eventId: "event blue",
        },
        { region: "us-east-1" },
      ],
    });
  });

  test("paginates events and distinguishes a later-page empty state", async () => {
    const core = new TestCoreClient();
    core.memory.setListEventsResponse({
      events: [event({ eventId: "page-one" })],
      nextToken: "page-2",
    });
    core.memory.setListEventsResponse({ events: [] }, "page-2");
    const screen = renderScreen("/agentcore/memory/event/list/memory-1/actor-1/session-1", {
      core,
    });

    await waitForText(screen.lastFrame, "page 1 · more →");
    await screen.write("l");
    await waitForText(screen.lastFrame, "No events on this page for session session-1.");
  });

  test("shows scoped empty and retry states", async () => {
    const empty = renderScreen("/agentcore/memory/event/list/memory-1/actor-1/session-1");
    await waitForText(empty.lastFrame, "No events found for session session-1.");
    empty.unmount();

    const core = new TestCoreClient();
    core.memory.setError(new Error("events unavailable"));
    const failed = renderScreen("/agentcore/memory/event/list/memory-1/actor-1/session-1", {
      core,
    });

    await waitForText(failed.lastFrame, "events unavailable");
    expect(failed.lastFrame()).toContain("[r] retry");

    core.memory.setError(undefined);
    core.memory.setListEventsResponse({ events: [event()] });
    await failed.write("r");
    await waitForText(failed.lastFrame, "event-1");
  });
});
