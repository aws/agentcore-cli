import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { HarnessEndpointPicker } from "../../../components/HarnessEndpointPicker";
import { Layout } from "../../../components/Layout";
import { Divider } from "../../../components/ui/divider";
import { Markdown } from "../../../components/ui/markdown";
import { Spinner } from "../../../components/ui/spinner";
import { StatusIndicator, type StatusValue } from "../../../components/ui/status-indicator";
import { TextInput } from "../../../components/ui/text-input";
import { darkTheme } from "../../../components/ui/_core.js";
import {
  applyEvent,
  applyExecEvent,
  finishExec,
  finishTurn,
  newExecItem,
  newSessionId,
  newTurn,
  turnSummary,
  type TranscriptItem,
  type Turn,
} from "./transcript";

const theme = darkTheme;

// HarnessInvokeScreen is the interactive chat for `harness invoke`. Without a
// `:harnessId` route value it renders a picker (choose which harness to chat
// with); with one it renders the chat itself. A `:sessionId` route value
// resumes that runtime session instead of starting a fresh one, and a
// `?qualifier=` search value targets that endpoint.
export function HarnessInvokeScreen(props: ScreenProps) {
  const { harnessId, sessionId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "invoke"]}
        description="choose a harness to chat with"
        onSelect={(id) => navigate(`/agentcore/harness/invoke/${id}`)}
      />
    );
  }
  return (
    <HarnessChat
      {...props}
      harnessId={harnessId}
      initialSessionId={sessionId}
      initialQualifier={search.get("qualifier") ?? undefined}
      variant="invoke"
    />
  );
}

// ─── chat ─────────────────────────────────────────────────────────────────────

// Mode is what enter does with the prompt: "chat" sends a message to the agent,
// "exec" runs a shell command in the session's container. Ctrl+E toggles.
type Mode = "chat" | "exec";

export interface HarnessChatProps extends ScreenProps {
  harnessId: string;
  // initialSessionId resumes an existing runtime session; omitted, the chat
  // starts a fresh one. The service holds conversation state server-side, so
  // resuming continues the agent's context (the transcript view starts empty).
  initialSessionId?: string;
  // initialQualifier is the endpoint the session targets (default DEFAULT,
  // which every harness has). Ctrl+T switches endpoints mid-chat.
  initialQualifier?: string;
  // variant is the command hosting the chat: it names the breadcrumb and picks
  // the starting mode ("exec" starts in exec mode; "invoke" in chat mode).
  variant: "invoke" | "exec";
  onBack?: () => void;
}

// HarnessChat is the conversation view shared by `invoke` and `exec`: a
// scrollable transcript, a one-row status line, and the prompt pinned at the
// bottom. One runtime session spans the whole chat — the service keeps
// conversation state server-side, so each send carries only the new user
// message, and exec-mode commands run in that same session's container.
export function HarnessChat({
  ctx,
  core,
  harnessId,
  initialSessionId,
  initialQualifier,
  variant,
  onBack,
}: HarnessChatProps) {
  const opts = coreOptsFromCtx(ctx);
  const { columns, rows } = useWindowSize();
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId, opts),
  });

  const [sessionId] = useState(() => initialSessionId ?? newSessionId());
  const [qualifier, setQualifier] = useState(initialQualifier ?? "DEFAULT");
  const [pickingEndpoint, setPickingEndpoint] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<Mode>(variant === "exec" ? "exec" : "chat");
  const [items, setItems] = useState<TranscriptItem[]>([]);

  // The stream loop is async and outlives any single render, so everything it
  // touches lives in refs: it must append to the *latest* transcript (not a
  // stale closure's copy) and stop mutating state after unmount.
  const historyRef = useRef<TranscriptItem[]>([]);
  const turnRef = useRef<Turn | null>(null);
  const streamingRef = useRef(false);
  const modeRef = useRef(variant === "exec" ? ("exec" as Mode) : ("chat" as Mode));
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);
  // stick keeps the view pinned to the newest output; scrolling up releases it,
  // returning to the bottom (or sending) re-engages it.
  const stickRef = useRef(true);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollToBottom();
  }, [items]);

  // sync publishes the ref-held transcript (settled history + the in-flight
  // turn) into React state so Ink re-renders.
  const sync = () => {
    if (!aliveRef.current) return;
    setItems([...historyRef.current, ...(turnRef.current?.items ?? [])]);
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    const arn = detail.data?.harness?.arn;
    if (trimmed === "" || streamingRef.current || !arn) return;

    setInput("");
    stickRef.current = true;
    historyRef.current.push({ kind: "user", text: trimmed });
    const turn = newTurn();
    turnRef.current = turn;
    streamingRef.current = true;
    setStreaming(true);
    sync();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await core.harness.invokeHarness(
        {
          harnessArn: arn,
          qualifier,
          runtimeSessionId: sessionId,
          messages: [{ role: "user", content: [{ text: trimmed }] }],
        },
        opts,
        controller.signal,
      );
      for await (const event of response.stream ?? []) {
        if (!aliveRef.current) return;
        applyEvent(turn, event);
        sync();
      }
      finishTurn(turn);
      turn.items.push({ kind: "notice", text: turnSummary(turn) });
    } catch (error) {
      finishTurn(turn);
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") {
        turn.items.push({ kind: "notice", text: "interrupted" });
      } else {
        turn.items.push({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      historyRef.current.push(...turn.items);
      turnRef.current = null;
      abortRef.current = null;
      streamingRef.current = false;
      if (aliveRef.current) {
        setStreaming(false);
        sync();
      }
    }
  };

  // runExec runs a shell command in the chat session's container (exec mode)
  // and folds the streamed stdout/stderr into an exec transcript item.
  const runExec = async (text: string) => {
    const command = text.trim();
    const arn = detail.data?.harness?.arn;
    if (command === "" || streamingRef.current || !arn) return;

    setInput("");
    stickRef.current = true;
    const item = newExecItem(command);
    historyRef.current.push(item);
    streamingRef.current = true;
    setStreaming(true);
    sync();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await core.harness.invokeAgentRuntimeCommand(
        // The chat's own session id: the command runs in the same container
        // the conversation runs in.
        { agentRuntimeArn: arn, qualifier, runtimeSessionId: sessionId, body: { command } },
        opts,
        controller.signal,
      );
      for await (const event of response.stream ?? []) {
        if (!aliveRef.current) return;
        applyExecEvent(item, event);
        sync();
      }
      finishExec(item);
    } catch (error) {
      finishExec(item);
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") {
        historyRef.current.push({ kind: "notice", text: "interrupted" });
      } else {
        historyRef.current.push({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      abortRef.current = null;
      streamingRef.current = false;
      if (aliveRef.current) {
        setStreaming(false);
        sync();
      }
    }
  };

  // submit routes enter by the current mode: chat sends to the agent, exec runs
  // a command.
  const submit = (value: string) => {
    void (modeRef.current === "exec" ? runExec(value) : send(value));
  };

  const toggleMode = () => {
    const next: Mode = modeRef.current === "exec" ? "chat" : "exec";
    modeRef.current = next;
    setMode(next);
  };

  // Esc interrupts a running turn or pops back when idle; ctrl+e flips between
  // chat and exec mode; ctrl+t opens the endpoint switcher when idle; arrows
  // scroll the transcript. Text editing and enter-to-send belong to the
  // TextInput below — the two handlers own disjoint keys. The whole handler
  // stands down while the endpoint picker overlay owns the keys.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "e") {
        toggleMode();
        return;
      }
      if (key.ctrl && input === "t") {
        if (!streamingRef.current) setPickingEndpoint(true);
        return;
      }
      if (key.escape) {
        if (streamingRef.current) abortRef.current?.abort();
        else if (onBack) onBack();
        else navigate(-1);
        return;
      }
      const view = scrollRef.current;
      if (!view) return;
      if (key.upArrow) {
        const offset = view.getScrollOffset();
        view.scrollBy(-1);
        if (offset - 1 < view.getBottomOffset()) stickRef.current = false;
      }
      if (key.downArrow) {
        const offset = view.getScrollOffset();
        view.scrollBy(1);
        if (offset + 1 >= view.getBottomOffset()) stickRef.current = true;
      }
    },
    { isActive: !pickingEndpoint },
  );

  // The ctrl+t endpoint switcher: pick an endpoint and later sends target its
  // qualifier; esc closes the overlay with the qualifier unchanged.
  if (pickingEndpoint) {
    return (
      <HarnessEndpointPicker
        ctx={ctx}
        core={core}
        harnessId={harnessId}
        breadcrumb={["agentcore", "harness", variant, harnessId, "endpoint"]}
        description="choose the endpoint to use"
        onSelect={(endpointName) => {
          setQualifier(endpointName);
          setPickingEndpoint(false);
        }}
        onEscape={() => setPickingEndpoint(false)}
      />
    );
  }

  return (
    <Layout
      breadcrumb={["agentcore", "harness", variant, harnessId]}
      keyHints={
        streaming
          ? [
              { key: "esc", label: "interrupt" },
              { key: "ctl+c", label: "quit" },
            ]
          : [
              { key: "enter", label: mode === "exec" ? "run" : "send" },
              { key: "ctl+e", label: mode === "exec" ? "chat mode" : "exec mode" },
              { key: "ctl+t", label: "endpoint" },
              { key: "↑↓", label: "scroll" },
              { key: "esc", label: "back" },
              { key: "ctl+c", label: "quit" },
            ]
      }
    >
      {detail.isPending ? (
        <Spinner label="loading harness…" />
      ) : detail.isError ? (
        <Text color="red">Error: {(detail.error as Error).message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box height={rows - 8} flexDirection="column">
            <ScrollView ref={scrollRef}>
              {items.map((item, i) => (
                <Box key={i} paddingBottom={1}>
                  <ItemView item={item} width={columns} />
                </Box>
              ))}
            </ScrollView>
          </Box>

          <Divider />

          <Box>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              prompt={mode === "exec" ? "$ " : "❯ "}
              placeholder={mode === "exec" ? "run a command…" : "send a message…"}
            />
          </Box>

          <Divider />

          <Box height={1}>
            {streaming ? (
              <Spinner label="working… (esc to interrupt)" />
            ) : (
              <Text color={theme.colors.muted}>
                session: {sessionId} · qualifier: {qualifier}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Layout>
  );
}

// ─── transcript rendering ─────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// resultPreview reduces a tool result to its first line plus a line count, so a
// large payload never floods the transcript.
function resultPreview(result: string): string {
  const lines = result.trimEnd().split("\n");
  const first = truncate(lines[0] ?? "", 80);
  return lines.length > 1 ? `${first} … (+${lines.length - 1} lines)` : first;
}

const TOOL_STATUS: Record<string, StatusValue> = {
  running: "loading",
  success: "online",
  error: "error",
};

// ItemView renders one transcript item in its Claude Code-style shape: `❯` user
// lines, `⏺` assistant text (Markdown once settled), `✻` reasoning, a
// StatusIndicator per tool call with a result preview, and red `✗` errors.
function ItemView({ item, width }: { item: TranscriptItem; width: number }) {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color={theme.colors.text}>❯ </Text>
          <Box width={width - 4}>
            <Text color={theme.colors.text}>{item.text}</Text>
          </Box>
        </Box>
      );
    case "text":
      if (item.streaming) {
        return (
          <Box>
            <Text>⏺ </Text>
            <Box width={width - 4}>
              <Text>{item.text}</Text>
              <Text color={theme.colors.text}>▌</Text>
            </Box>
          </Box>
        );
      }
      return (
        <Box>
          <Text>⏺ </Text>
          <Box width={width - 4}>
            <Markdown content={item.text} width={width - 4} />
          </Box>
        </Box>
      );
    case "reasoning":
      return (
        <Text color={theme.colors.muted} italic>
          ✻ {item.text}
          {item.streaming ? "▌" : ""}
        </Text>
      );
    case "tool": {
      const label = `${item.serverName ? `${item.serverName}:` : ""}${item.name}`;
      return (
        <Box flexDirection="column">
          <StatusIndicator status={TOOL_STATUS[item.status]!} label={label} />
          {item.result !== "" ? (
            <Text color={item.status === "error" ? theme.colors.error : theme.colors.muted}>
              {"  └ "}
              {resultPreview(item.result)}
            </Text>
          ) : null}
        </Box>
      );
    }
    case "exec":
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.colors.text}>$ </Text>
            <Box width={width - 4}>
              <Text color={theme.colors.text}>{item.command}</Text>
            </Box>
          </Box>
          {item.output !== "" || item.status === "running" ? (
            <Box paddingLeft={2} width={width - 2}>
              <Text color={item.status === "error" ? theme.colors.error : theme.colors.muted}>
                {item.output.trimEnd()}
                {item.status === "running" ? "▌" : ""}
              </Text>
            </Box>
          ) : null}
          {item.status === "error" && item.exitCode !== undefined && item.exitCode !== 0 ? (
            <Box paddingLeft={2}>
              <Text color={theme.colors.error}>exit {item.exitCode}</Text>
            </Box>
          ) : null}
        </Box>
      );
    case "error":
      return <Text color={theme.colors.error}>✗ {item.message}</Text>;
    case "notice":
      return (
        <Box paddingLeft={2}>
          <Text color={theme.colors.muted}>{item.text}</Text>
        </Box>
      );
  }
}
