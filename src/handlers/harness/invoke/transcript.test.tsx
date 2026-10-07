import { test, expect, describe } from "bun:test";
import type {
  InvokeAgentRuntimeCommandStreamOutput,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  applyEvent,
  applyExecEvent,
  compactJson,
  finishExec,
  finishTurn,
  newExecItem,
  newSessionId,
  newTurn,
  turnSummary,
  type ExecItem,
  type Turn,
} from "./transcript";

// Unit tests for the pure transcript reducer: stream events in, display items
// out. Event literals mirror the SDK's InvokeHarnessStreamOutput union members.

function fold(events: InvokeHarnessStreamOutput[]): Turn {
  const turn = newTurn();
  for (const event of events) applyEvent(turn, event);
  return turn;
}

const messageStart: InvokeHarnessStreamOutput = { messageStart: { role: "assistant" } };

function textDelta(index: number, text: string): InvokeHarnessStreamOutput {
  return { contentBlockDelta: { contentBlockIndex: index, delta: { text } } };
}

function blockStop(index: number): InvokeHarnessStreamOutput {
  return { contentBlockStop: { contentBlockIndex: index } };
}

function messageStop(stopReason: string): InvokeHarnessStreamOutput {
  return { messageStop: { stopReason } } as InvokeHarnessStreamOutput;
}

describe("text blocks", () => {
  test("deltas accumulate into one lazily created item and settle on stop", () => {
    const turn = fold([messageStart, textDelta(0, "Hello"), textDelta(0, ", world")]);

    expect(turn.items).toEqual([{ kind: "text", text: "Hello, world", streaming: true }]);

    applyEvent(turn, blockStop(0));
    expect(turn.items).toEqual([{ kind: "text", text: "Hello, world", streaming: false }]);
  });

  test("block indexes reset per message, so a reused index starts a new item", () => {
    const turn = fold([
      messageStart,
      textDelta(0, "first message"),
      blockStop(0),
      messageStop("tool_use"),
      messageStart,
      textDelta(0, "second message"),
      blockStop(0),
      messageStop("end_turn"),
    ]);

    expect(turn.items).toEqual([
      { kind: "text", text: "first message", streaming: false },
      { kind: "text", text: "second message", streaming: false },
    ]);
  });
});

describe("reasoning blocks", () => {
  test("reasoning text deltas accumulate into a reasoning item", () => {
    const turn = fold([
      messageStart,
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "let me think" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: " harder" } },
        },
      },
      blockStop(0),
    ]);

    expect(turn.items).toEqual([
      { kind: "reasoning", text: "let me think harder", streaming: false },
    ]);
  });

  test("non-text reasoning deltas (signature) are ignored", () => {
    const turn = fold([
      messageStart,
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: "sig" } },
        },
      },
    ]);
    expect(turn.items).toEqual([]);
  });
});

describe("tool lifecycle", () => {
  const toolStart: InvokeHarnessStreamOutput = {
    contentBlockStart: {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: "tu-1", name: "get_weather", serverName: "weather-mcp" } },
    },
  };

  test("a tool runs, accumulates input, compacts it on stop, then succeeds with a result", () => {
    const turn = fold([
      messageStart,
      toolStart,
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{ "city":' } } } },
      {
        contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: ' "Portland" }' } } },
      },
    ]);

    expect(turn.items).toEqual([
      {
        kind: "tool",
        toolUseId: "tu-1",
        name: "get_weather",
        serverName: "weather-mcp",
        input: '{ "city": "Portland" }',
        status: "running",
        result: "",
      },
    ]);

    applyEvent(turn, blockStop(0));
    expect(turn.items[0]).toMatchObject({ input: '{"city":"Portland"}' });

    // The result arrives in a later message, reusing block index 0.
    applyEvent(turn, messageStop("tool_use"));
    applyEvent(turn, messageStart);
    applyEvent(turn, {
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolResult: { toolUseId: "tu-1", status: "success" } },
      },
    });
    applyEvent(turn, {
      contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: "Sunny, 25°C" }] } },
    });
    applyEvent(turn, blockStop(0));

    expect(turn.items).toEqual([
      {
        kind: "tool",
        toolUseId: "tu-1",
        name: "get_weather",
        serverName: "weather-mcp",
        input: '{"city":"Portland"}',
        status: "success",
        result: "Sunny, 25°C",
      },
    ]);
  });

  test("an error tool result flips the tool's status to error", () => {
    const turn = fold([
      messageStart,
      toolStart,
      blockStop(0),
      messageStop("tool_use"),
      messageStart,
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "tu-1", status: "error" } },
        },
      },
      {
        contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: "boom" }] } },
      },
    ]);

    expect(turn.items[0]).toMatchObject({ kind: "tool", status: "error", result: "boom" });
  });

  test("a result for an unseen toolUseId still creates a tool item", () => {
    const turn = fold([
      messageStart,
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "ghost-1", status: "success" } },
        },
      },
      {
        contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: "orphan" }] } },
      },
    ]);

    expect(turn.items).toEqual([
      {
        kind: "tool",
        toolUseId: "ghost-1",
        name: "ghost-1",
        input: "",
        status: "success",
        result: "orphan",
      },
    ]);
  });

  test("json result chunks are stringified one per line", () => {
    const turn = fold([
      messageStart,
      toolStart,
      blockStop(0),
      messageStart,
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "tu-1" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolResult: [{ json: { ok: true } }, { json: [1, 2] }] },
        },
      },
    ]);

    expect(turn.items[0]).toMatchObject({
      status: "success",
      result: '{"ok":true}\n[1,2]\n',
    });
  });
});

describe("turn completion", () => {
  test("an abnormal stop reason appends an `agent stopped` notice", () => {
    const turn = fold([messageStart, textDelta(0, "partial"), messageStop("max_tokens")]);

    expect(turn.items).toEqual([
      { kind: "text", text: "partial", streaming: false },
      { kind: "notice", text: "agent stopped: max_tokens" },
    ]);
  });

  test("metadata feeds the turn summary", () => {
    const turn = fold([
      messageStart,
      textDelta(0, "hi"),
      blockStop(0),
      messageStop("end_turn"),
      {
        metadata: {
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          metrics: { latencyMs: 1234 },
        },
      },
    ]);

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.usage?.totalTokens).toBe(150);
    expect(turn.latencyMs).toBe(1234);
    expect(turnSummary(turn)).toBe("end_turn · 150 tokens");
  });

  test("turnSummary omits pieces the stream never reported", () => {
    expect(turnSummary(newTurn())).toBe("done");
    const turn = fold([messageStop("end_turn")]);
    expect(turnSummary(turn)).toBe("end_turn");
  });

  test("finishTurn settles anything still streaming", () => {
    const turn = fold([messageStart, textDelta(0, "dangling")]);
    expect(turn.items[0]).toMatchObject({ streaming: true });

    finishTurn(turn);
    expect(turn.items[0]).toMatchObject({ streaming: false });
  });
});

describe("stream errors and unknown events", () => {
  test("stream-borne error members become error items", () => {
    const turn = fold([
      { validationException: { message: "bad input" } } as unknown as InvokeHarnessStreamOutput,
      {
        internalServerException: { message: "server oops" },
      } as unknown as InvokeHarnessStreamOutput,
      { runtimeClientError: { message: "container died" } } as unknown as InvokeHarnessStreamOutput,
    ]);

    expect(turn.items).toEqual([
      { kind: "error", message: "bad input" },
      { kind: "error", message: "server oops" },
      { kind: "error", message: "container died" },
    ]);
  });

  test("unknown events are ignored", () => {
    const turn = fold([
      { $unknown: ["newEventType", {}] } as unknown as InvokeHarnessStreamOutput,
      {} as InvokeHarnessStreamOutput,
      // Deltas for a block index that was never started are dropped too.
      { contentBlockDelta: { contentBlockIndex: 9, delta: { toolUse: { input: "{}" } } } },
      blockStop(9),
    ]);
    expect(turn.items).toEqual([]);
  });
});

describe("exec command stream", () => {
  function foldExec(command: string, events: InvokeAgentRuntimeCommandStreamOutput[]): ExecItem {
    const item = newExecItem(command);
    for (const event of events) applyExecEvent(item, event);
    return item;
  }

  test("stdout and stderr interleave in arrival order and exit 0 succeeds", () => {
    const item = foldExec("ls /", [
      { chunk: { contentStart: {} } },
      { chunk: { contentDelta: { stdout: "bin\n" } } },
      { chunk: { contentDelta: { stderr: "warning: slow disk\n" } } },
      { chunk: { contentDelta: { stdout: "usr\n" } } },
      { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } },
    ]);

    expect(item).toEqual({
      kind: "exec",
      command: "ls /",
      output: "bin\nwarning: slow disk\nusr\n",
      exitCode: 0,
      status: "success",
    });
  });

  test("a non-zero exit code fails the item", () => {
    const item = foldExec("false", [
      { chunk: { contentDelta: { stderr: "nope\n" } } },
      { chunk: { contentStop: { exitCode: 2, status: "COMPLETED" } } },
    ]);
    expect(item).toMatchObject({ status: "error", exitCode: 2, output: "nope\n" });
  });

  test("a timed-out command fails with a note in the output", () => {
    const item = foldExec("sleep 999", [
      { chunk: { contentStop: { exitCode: -1, status: "TIMED_OUT" } } },
    ]);
    expect(item).toMatchObject({ status: "error", exitCode: -1 });
    expect(item.output).toContain("command timed out");
  });

  test("stream-borne errors fail the item with the message in its output", () => {
    const item = foldExec("ls", [
      {
        validationException: { message: "bad session" },
      } as unknown as InvokeAgentRuntimeCommandStreamOutput,
    ]);
    expect(item.status).toBe("error");
    expect(item.output).toContain("bad session");
  });

  test("unknown events are ignored and finishExec settles a dangling command", () => {
    const item = foldExec("ls", [
      { $unknown: ["future", {}] } as unknown as InvokeAgentRuntimeCommandStreamOutput,
      { chunk: { contentDelta: { stdout: "partial" } } },
    ]);
    expect(item.status).toBe("running");

    finishExec(item);
    expect(item.status).toBe("error");

    // A settled item is left alone.
    const done = foldExec("true", [
      { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } },
    ]);
    finishExec(done);
    expect(done.status).toBe("success");
  });
});

describe("helpers", () => {
  test("compactJson compacts valid JSON and passes through the rest trimmed", () => {
    expect(compactJson('{\n  "a": 1\n}')).toBe('{"a":1}');
    expect(compactJson("  not json  ")).toBe("not json");
    expect(compactJson("")).toBe("");
  });

  test("newSessionId satisfies the service's 33-100 character constraint", () => {
    const id = newSessionId();
    expect(id.length).toBeGreaterThanOrEqual(33);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(newSessionId()).not.toBe(id);
  });
});
