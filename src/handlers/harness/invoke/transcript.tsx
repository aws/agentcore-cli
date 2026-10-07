import type {
  HarnessTokenUsage,
  InvokeAgentRuntimeCommandStreamOutput,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";

// The transcript reducer folds a harness invocation's stream events into a flat
// list of display items. It is pure data-in/data-out (no React, no IO), so the
// TUI chat screen and the JSON-emitting CLI handler share the exact same
// interpretation of the stream: what a tool call looks like, when a text block
// settles, how errors surface.

// TranscriptItem is one visible row of a conversation. Items are plain
// serializable objects so the CLI can emit them as JSON verbatim.
export type TranscriptItem =
  // A message the user sent.
  | { kind: "user"; text: string }
  // Streamed assistant text; `streaming` flips off when the block settles.
  | { kind: "text"; text: string; streaming: boolean }
  // Streamed assistant reasoning (extended thinking).
  | { kind: "reasoning"; text: string; streaming: boolean }
  // A tool call: `input` accumulates the streamed JSON arguments and `result`
  // the streamed tool result; `status` tracks the call through its lifecycle.
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      serverName?: string;
      input: string;
      status: "running" | "success" | "error";
      result: string;
    }
  // A shell command run in the harness's runtime container (exec mode).
  // `output` interleaves stdout and stderr in arrival order.
  | {
      kind: "exec";
      command: string;
      output: string;
      exitCode?: number;
      status: "running" | "success" | "error";
    }
  // A stream-borne or transport error.
  | { kind: "error"; message: string }
  // An informational line (turn summary, abnormal stop, interruption).
  | { kind: "notice"; text: string };

export type ExecItem = Extract<TranscriptItem, { kind: "exec" }>;

// Turn is the reducer state for a single invocation. `blocks` maps the current
// message's contentBlockIndex to the item it feeds — indexes are scoped per
// message and reused across messages, so the map resets on every messageStart.
// `toolsById` maps toolUseId to the tool item's position in `items` so a tool
// result (which arrives in a later message) can find the call it belongs to.
export interface Turn {
  items: TranscriptItem[];
  blocks: Map<number, TranscriptItem>;
  toolsById: Record<string, number>;
  stopReason?: string;
  usage?: HarnessTokenUsage;
  latencyMs?: number;
}

export function newTurn(): Turn {
  return { items: [], blocks: new Map(), toolsById: {} };
}

// Stop reasons that are part of a normal agent loop; anything else gets an
// "agent stopped" notice appended so the user learns why the turn ended early.
const NORMAL_STOP_REASONS = new Set(["end_turn", "tool_use", "tool_result"]);

// compactJson re-serializes a JSON string without whitespace, so streamed tool
// input (accumulated as pretty or fragmented chunks) renders on one line.
// Non-JSON input is returned trimmed rather than thrown on — the stream is
// display data, not something to validate.
export function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.trim();
  }
}

// newSessionId mints a runtime session id. The service requires 33-100
// characters; a UUID's 36 satisfy that.
export function newSessionId(): string {
  return crypto.randomUUID();
}

// appendResult adds a tool-result chunk to a tool item: text chunks concatenate
// as-is, json chunks are stringified one per line.
function appendResult(
  tool: Extract<TranscriptItem, { kind: "tool" }>,
  chunk: { text?: string; json?: unknown },
): void {
  if (chunk.text !== undefined) {
    tool.result += chunk.text;
  } else if (chunk.json !== undefined) {
    if (tool.result !== "" && !tool.result.endsWith("\n")) tool.result += "\n";
    tool.result += JSON.stringify(chunk.json) + "\n";
  }
}

// streamItem returns the item accumulating text at `index`, creating it lazily —
// text and reasoning blocks have no contentBlockStart, so their first delta is
// the only signal a block began.
function streamItem(turn: Turn, index: number, kind: "text" | "reasoning") {
  const existing = turn.blocks.get(index);
  if (existing && existing.kind === kind) return existing;
  const item = { kind, text: "", streaming: true };
  turn.items.push(item);
  turn.blocks.set(index, item);
  return item;
}

// toolByUseId finds the tool item a result refers to. A result for a toolUseId
// we never saw a call for still gets an item — the transcript should show the
// result rather than drop it.
function toolByUseId(turn: Turn, toolUseId: string): Extract<TranscriptItem, { kind: "tool" }> {
  const index = turn.toolsById[toolUseId];
  const existing = index === undefined ? undefined : turn.items[index];
  if (existing && existing.kind === "tool") return existing;
  const item: Extract<TranscriptItem, { kind: "tool" }> = {
    kind: "tool",
    toolUseId,
    name: toolUseId,
    input: "",
    status: "running",
    result: "",
  };
  turn.toolsById[toolUseId] = turn.items.length;
  turn.items.push(item);
  return item;
}

// applyEvent folds one stream event into the turn, mutating it in place.
// Unknown or irrelevant events are ignored; the stream's future growth must not
// break rendering.
export function applyEvent(turn: Turn, event: InvokeHarnessStreamOutput): void {
  if (event.messageStart) {
    // Content block indexes restart at 0 in each message; drop the old mapping
    // so a reused index never appends into the previous message's items.
    turn.blocks = new Map();
    return;
  }

  if (event.contentBlockStart) {
    const { contentBlockIndex, start } = event.contentBlockStart;
    if (contentBlockIndex === undefined || start === undefined) return;
    if (start.toolUse) {
      const item: TranscriptItem = {
        kind: "tool",
        toolUseId: start.toolUse.toolUseId ?? "",
        name: start.toolUse.name ?? "",
        ...(start.toolUse.serverName ? { serverName: start.toolUse.serverName } : {}),
        input: "",
        status: "running",
        result: "",
      };
      turn.toolsById[item.toolUseId] = turn.items.length;
      turn.items.push(item);
      turn.blocks.set(contentBlockIndex, item);
    } else if (start.toolResult) {
      const tool = toolByUseId(turn, start.toolResult.toolUseId ?? "");
      tool.status = start.toolResult.status === "error" ? "error" : "success";
      turn.blocks.set(contentBlockIndex, tool);
    }
    return;
  }

  if (event.contentBlockDelta) {
    const { contentBlockIndex, delta } = event.contentBlockDelta;
    if (contentBlockIndex === undefined || delta === undefined) return;
    if (delta.text !== undefined) {
      streamItem(turn, contentBlockIndex, "text").text += delta.text;
    } else if (delta.reasoningContent?.text !== undefined) {
      streamItem(turn, contentBlockIndex, "reasoning").text += delta.reasoningContent.text;
    } else if (delta.toolUse) {
      const item = turn.blocks.get(contentBlockIndex);
      if (item?.kind === "tool") item.input += delta.toolUse.input ?? "";
    } else if (delta.toolResult) {
      const item = turn.blocks.get(contentBlockIndex);
      if (item?.kind === "tool") {
        for (const chunk of delta.toolResult) appendResult(item, chunk);
      }
    }
    return;
  }

  if (event.contentBlockStop) {
    const item = turn.blocks.get(event.contentBlockStop.contentBlockIndex ?? -1);
    if (!item) return;
    if (item.kind === "text" || item.kind === "reasoning") item.streaming = false;
    if (item.kind === "tool") item.input = compactJson(item.input);
    return;
  }

  if (event.messageStop) {
    const reason = event.messageStop.stopReason;
    turn.stopReason = reason;
    // Settle any block whose stop event never arrived within this message.
    for (const item of turn.blocks.values()) {
      if (item.kind === "text" || item.kind === "reasoning") item.streaming = false;
    }
    if (reason && !NORMAL_STOP_REASONS.has(reason)) {
      turn.items.push({ kind: "notice", text: `agent stopped: ${reason}` });
    }
    return;
  }

  if (event.metadata) {
    turn.usage = event.metadata.usage;
    turn.latencyMs = event.metadata.metrics?.latencyMs;
    return;
  }

  const error =
    event.validationException ?? event.internalServerException ?? event.runtimeClientError;
  if (error) {
    turn.items.push({ kind: "error", message: error.message ?? String(error) });
  }
}

// finishTurn settles anything still streaming — the stream may end (or be
// aborted) without the stop events that normally close blocks out.
export function finishTurn(turn: Turn): void {
  for (const item of turn.items) {
    if (item.kind === "text" || item.kind === "reasoning") item.streaming = false;
  }
}

// turnSummary renders the turn's outcome on one line, e.g.
// `end_turn · 150 tokens`. Pieces the stream never reported are omitted.
export function turnSummary(turn: Turn): string {
  const parts: string[] = [turn.stopReason ?? "done"];
  if (turn.usage?.totalTokens !== undefined) parts.push(`${turn.usage.totalTokens} tokens`);
  return parts.join(" · ");
}

// ─── exec (InvokeAgentRuntimeCommand) ─────────────────────────────────────────

export function newExecItem(command: string): ExecItem {
  return { kind: "exec", command, output: "", status: "running" };
}

// appendLine adds `text` on its own line of the exec output.
function appendLine(item: ExecItem, text: string): void {
  if (item.output !== "" && !item.output.endsWith("\n")) item.output += "\n";
  item.output += text + "\n";
}

// applyExecEvent folds one command-stream event into the exec item, mutating it
// in place: output deltas accumulate, the stop event settles the exit code, and
// stream-borne errors fail the item with the message in its output. Unknown
// events are ignored.
export function applyExecEvent(item: ExecItem, event: InvokeAgentRuntimeCommandStreamOutput): void {
  if (event.chunk) {
    const { contentDelta, contentStop } = event.chunk;
    if (contentDelta) {
      item.output += (contentDelta.stdout ?? "") + (contentDelta.stderr ?? "");
    }
    if (contentStop) {
      item.exitCode = contentStop.exitCode;
      if (contentStop.status === "TIMED_OUT") appendLine(item, "command timed out");
      item.status =
        contentStop.status === "COMPLETED" && contentStop.exitCode === 0 ? "success" : "error";
    }
    return;
  }

  const error =
    event.validationException ??
    event.accessDeniedException ??
    event.resourceNotFoundException ??
    event.serviceQuotaExceededException ??
    event.throttlingException ??
    event.internalServerException ??
    event.runtimeClientError;
  if (error) {
    item.status = "error";
    appendLine(item, error.message ?? String(error));
  }
}

// finishExec settles an exec item whose stream ended (or was aborted) without a
// contentStop: a command with no exit code did not complete.
export function finishExec(item: ExecItem): void {
  if (item.status === "running") item.status = "error";
}
