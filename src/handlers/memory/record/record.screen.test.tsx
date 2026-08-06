import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetMemoryRecordOutput,
  MemoryRecord,
  MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
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

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryRecordId: "record-1",
    content: { text: "Customer prefers email notifications." },
    memoryStrategyId: "strategy-1",
    namespaces: ["/customers/acme"],
    createdAt: new Date("2026-08-03T12:34:56.000Z"),
    ...overrides,
  };
}

function recordSummary(overrides: Partial<MemoryRecordSummary> = {}): MemoryRecordSummary {
  return record(overrides);
}

describe("Memory record list flow", () => {
  test("uses the Memory picker before asking for a namespace scope", async () => {
    const memoryId = "memory/blue one";
    const core = new TestCoreClient();
    core.memory.setListResponse({
      memories: [memorySummary({ id: memoryId })],
    });
    const screen = renderScreen("/agentcore/memory/record/list", { core });

    await waitForText(screen.lastFrame, memoryId);
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → memory → record → list → ${memoryId}`);

    const frame = screen.lastFrame()!;
    expect(frame).toContain("scope type");
    expect(frame).toContain("namespace path");
    expect(frame).toContain("namespace");
    expect(core.memory.calls.some((call) => call.method === "listMemoryRecords")).toBe(false);
  });

  test("unwinds the record table through its scope and Memory pickers", async () => {
    const memoryId = "memory/blue one";
    const core = new TestCoreClient();
    core.memory.setListResponse({
      memories: [memorySummary({ id: memoryId })],
    });
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [recordSummary()],
    });
    const screen = renderScreen("/agentcore/memory/record/list", { core });

    await waitForText(screen.lastFrame, memoryId);
    await screen.press("return");
    await waitForText(screen.lastFrame, "scope type");
    await screen.write("/customers/acme");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Customer prefers email notifications.");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "scope type");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Memory to list records for");
  });

  test("submits a namespace prefix and calls listMemoryRecords with exact options", async () => {
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [recordSummary()],
    });
    const screen = renderScreen("/agentcore/memory/record/list/memory-1", {
      core,
      endpointUrl: memoryEndpointUrl,
    });

    await waitForText(screen.lastFrame, "scope type");
    await screen.write("/customers/acme");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Customer prefers email notifications.");
    await waitFor(() => core.memory.calls.some((call) => call.method === "listMemoryRecords"));

    expect(core.memory.calls.filter((call) => call.method === "listMemoryRecords")).toEqual([
      {
        method: "listMemoryRecords",
        args: [
          {
            memoryId: "memory-1",
            namespace: "/customers/acme",
            namespacePath: undefined,
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

  test("maps namespace-path scope to namespacePath", async () => {
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [recordSummary()],
    });
    const screen = renderScreen("/agentcore/memory/record/list/memory-1", { core });

    await waitForText(screen.lastFrame, "scope type");
    await screen.press("down");
    await screen.write("/customers/acme/*");
    await screen.press("return");
    await waitFor(() => core.memory.calls.some((call) => call.method === "listMemoryRecords"));

    expect(core.memory.calls.find((call) => call.method === "listMemoryRecords")).toEqual({
      method: "listMemoryRecords",
      args: [
        {
          memoryId: "memory-1",
          namespace: undefined,
          namespacePath: "/customers/acme/*",
          maxResults: expect.any(Number),
          nextToken: undefined,
        },
        { region: "us-east-1" },
      ],
    });
  });

  test("renders record columns and opens the selected record JSON", async () => {
    const response: GetMemoryRecordOutput = {
      memoryRecord: record({ metadata: { tenant: { stringValue: "acme" } } }),
    };
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [
        recordSummary({
          memoryRecordId: "record blue",
          memoryStrategyId: "summary-strategy",
        }),
      ],
    });
    core.memory.setGetMemoryRecordResponse(response);
    const screen = renderScreen(
      "/agentcore/memory/record/list/memory-1/namespace/%2Fcustomers%2Facme",
      { core },
    );

    await waitForText(screen.lastFrame, "record blue");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("content");
    expect(frame).toContain("strategy");
    expect(frame).toContain("created UTC");
    expect(frame).toContain("summary-strategy");
    expect(frame).toContain("2026-08-03 12:34");

    await screen.press("return");
    await waitForText(screen.lastFrame, '"tenant"');
    expect(core.memory.calls.find((call) => call.method === "getMemoryRecord")).toEqual({
      method: "getMemoryRecord",
      args: [
        {
          memoryId: "memory-1",
          memoryRecordId: "record blue",
        },
        { region: "us-east-1" },
      ],
    });
  });

  test("paginates records and distinguishes later-page empty state", async () => {
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [recordSummary({ memoryRecordId: "page-one" })],
      nextToken: "page-2",
    });
    core.memory.setListMemoryRecordsResponse({ memoryRecordSummaries: [] }, "page-2");
    const screen = renderScreen("/agentcore/memory/record/list/memory-1/namespace/%2Fcustomers", {
      core,
    });

    await waitForText(screen.lastFrame, "page 1 · more →");
    await screen.write("l");
    await waitForText(screen.lastFrame, "No Memory records on this page for namespace /customers.");
  });

  test("shows the scoped empty state and retries list failures", async () => {
    const empty = renderScreen("/agentcore/memory/record/list/memory-1/namespace/%2Fcustomers");
    await waitForText(empty.lastFrame, "No Memory records found for namespace /customers.");
    empty.unmount();

    const core = new TestCoreClient();
    core.memory.setError(new Error("records unavailable"));
    const failed = renderScreen("/agentcore/memory/record/list/memory-1/namespace/%2Fcustomers", {
      core,
    });

    await waitForText(failed.lastFrame, "records unavailable");
    expect(failed.lastFrame()).toContain("[r] retry");

    core.memory.setError(undefined);
    core.memory.setListMemoryRecordsResponse({
      memoryRecordSummaries: [recordSummary()],
    });
    await failed.write("r");
    await waitForText(failed.lastFrame, "Customer prefers email notifications.");
  });

  test("requires a non-empty namespace value", async () => {
    const screen = renderScreen("/agentcore/memory/record/list/memory-1");

    await waitForText(screen.lastFrame, "scope type");
    await screen.press("return");
    await waitForText(screen.lastFrame, "A namespace value is required.");
    expect(screen.core.memory.calls).toEqual([]);
  });
});
