import { afterEach, describe, expect, test } from "bun:test";
import type { Event, SessionSummary } from "@aws-sdk/client-bedrock-agentcore";
import { cleanupScreens, renderScreen, TestCoreClient, waitForText } from "../../../testing";

afterEach(cleanupScreens);

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
    ...overrides,
  };
}

describe("Memory session list flow", () => {
  test("renders session details and opens the selected session's events", async () => {
    const memoryId = "memory-1";
    const actorId = "actor-1";
    const sessionId = "session blue";
    const core = new TestCoreClient();
    core.memory.setListSessionsResponse({
      sessionSummaries: [session({ actorId, sessionId })],
    });
    core.memory.setListEventsResponse({
      events: [event({ memoryId, actorId, sessionId })],
    });
    const screen = renderScreen(`/agentcore/memory/session/list/${memoryId}/${actorId}`, { core });

    await waitForText(screen.lastFrame, sessionId);
    const frame = screen.lastFrame()!;
    expect(frame).toContain("session ID");
    expect(frame).toContain("created UTC");
    expect(frame).toContain("2026-08-02 10:20");

    await screen.press("return");
    await waitForText(screen.lastFrame, "event-1");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a session to list events for");
  });

  test("shows empty and retry states for session lists", async () => {
    const empty = renderScreen("/agentcore/memory/session/list/memory-1/actor-1");
    await waitForText(empty.lastFrame, "No sessions found for actor actor-1.");
    empty.unmount();

    const core = new TestCoreClient();
    core.memory.setError(new Error("sessions unavailable"));
    const failed = renderScreen("/agentcore/memory/session/list/memory-1/actor-1", { core });

    await waitForText(failed.lastFrame, "sessions unavailable");
    core.memory.setError(undefined);
    core.memory.setListSessionsResponse({ sessionSummaries: [session()] });
    await failed.write("r");
    await waitForText(failed.lastFrame, "session-1");
  });
});
