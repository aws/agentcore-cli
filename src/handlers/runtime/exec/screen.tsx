import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useWindowSize } from "../../../components/ui/useWindowSize";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import cliTruncate from "cli-truncate";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import {
  applyExecEvent,
  finishExec,
  newExecItem,
  type ExecItem,
} from "../../harness/invoke/transcript";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

const execPath = (...parts: string[]) =>
  ["/agentcore/runtime/exec", ...parts.map(encodeURIComponent)].join("/");

export function RuntimeExecScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { state } = useLocation();
  const returnOnEscape = (state as { returnOnEscape?: boolean } | null)?.returnOnEscape;
  const query = search.size ? `?${search}` : "";
  const breadcrumb = ["agentcore", "runtime", "exec"];
  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={breadcrumb}
        description="choose a Runtime to exec into"
        onSelect={(id) => navigate(execPath(id) + query)}
      />
    );
  }
  if (!qualifier) {
    return (
      <RuntimeEndpointPicker
        {...props}
        runtimeId={runtimeId}
        breadcrumb={[...breadcrumb, runtimeId]}
        description="choose an endpoint to exec into"
        onSelect={(name) =>
          navigate(execPath(runtimeId, name) + query, { replace: returnOnEscape, state })
        }
        onEscape={() => (returnOnEscape ? navigate(-1) : navigate(execPath()))}
      />
    );
  }
  return (
    <RuntimeExec
      {...props}
      key={`${runtimeId}/${qualifier}`}
      runtimeId={runtimeId}
      initialQualifier={qualifier}
      onBack={() => (returnOnEscape ? navigate(-1) : navigate(execPath(runtimeId)))}
    />
  );
}

function RuntimeExec({
  ctx,
  core,
  runtimeId,
  initialQualifier,
  onBack,
}: ScreenProps & {
  runtimeId: string;
  initialQualifier: string;
  onBack: () => void;
}) {
  const opts = coreOptsFromCtx(ctx);
  const { columns, rows } = useWindowSize();
  const [search] = useSearchParams();
  const [sessionId, setSessionId] = useState(() => search.get("session-id") ?? randomUUID());
  const timeout = search.has("timeout") ? Number(search.get("timeout")) : undefined;
  const [qualifier, setQualifier] = useState(initialQualifier);
  const [picking, setPicking] = useState(false);
  const [input, setInput] = useState("");
  const [items, setItems] = useState<ExecItem[]>([]);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollViewRef>(null);
  const stick = useRef(true);
  const detail = useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: ({ signal }) => core.runtime.getRuntime(runtimeId, opts, signal),
  });
  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
    },
    [],
  );

  const run = async () => {
    const command = input.trim();
    if (!command || !detail.data?.agentRuntimeArn || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    stick.current = true;
    const item = newExecItem(command);
    setInput("");
    setItems((current) => [...current, item]);
    try {
      const response = await core.runtime.invokeAgentRuntimeCommand(
        {
          agentRuntimeArn: detail.data.agentRuntimeArn,
          qualifier,
          runtimeSessionId: sessionId,
          body: { command, timeout },
        },
        opts,
        controller.signal,
      );
      if (abort.current !== controller) return;
      if (response.runtimeSessionId) setSessionId(response.runtimeSessionId);
      for await (const event of response.stream ?? []) {
        if (abort.current !== controller) return;
        applyExecEvent(item, event);
        setItems((current) => [...current]);
      }
    } catch (error) {
      item.status = "error";
      item.output += `${item.output && !item.output.endsWith("\n") ? "\n" : ""}${
        controller.signal.aborted
          ? "interrupted"
          : error instanceof Error
            ? error.message
            : String(error)
      }\n`;
    } finally {
      finishExec(item);
      if (abort.current === controller) {
        abort.current = null;
        setItems((current) => [...current]);
      }
    }
  };

  useInput(
    (keyInput, key) => {
      if (key.escape) {
        if (abort.current) abort.current.abort();
        else onBack();
      } else if (key.ctrl && keyInput === "t" && !abort.current) {
        setPicking(true);
      } else if ((key.upArrow || key.downArrow) && scroll.current) {
        const next = Math.max(
          0,
          Math.min(
            scroll.current.getBottomOffset(),
            scroll.current.getScrollOffset() + (key.upArrow ? -1 : 1),
          ),
        );
        scroll.current.scrollTo(next);
        stick.current = next >= scroll.current.getBottomOffset();
      }
    },
    { isActive: !picking },
  );

  const breadcrumb = ["agentcore", "runtime", "exec", runtimeId];
  if (picking) {
    return (
      <RuntimeEndpointPicker
        ctx={ctx}
        core={core}
        runtimeId={runtimeId}
        breadcrumb={breadcrumb}
        onSelect={(name) => {
          if (name !== qualifier) {
            setQualifier(name);
            setSessionId(randomUUID());
            setItems([]);
          }
          setPicking(false);
        }}
        onEscape={() => setPicking(false)}
      />
    );
  }
  const busy = items.at(-1)?.status === "running";
  return (
    <Layout
      breadcrumb={[...breadcrumb, qualifier]}
      keyHints={
        busy
          ? [
              { key: "esc", label: "interrupt" },
              { key: "ctrl+c", label: "quit" },
            ]
          : [
              { key: "enter", label: "run" },
              { key: "ctrl+t", label: "endpoint" },
              { key: "\u2191\u2193", label: "scroll" },
              { key: "esc", label: "back" },
              { key: "ctrl+c", label: "quit" },
            ]
      }
    >
      {detail.isPending ? (
        <Spinner label="loading Runtime..." />
      ) : detail.error ? (
        <Text color="red">{detail.error.message}</Text>
      ) : !detail.data.agentRuntimeArn ? (
        <Text color="red">Runtime returned no ARN</Text>
      ) : (
        <Box flexDirection="column">
          <Box
            height={Math.max(1, rows - 7 - Math.min(4, input.split("\n").length))}
            flexDirection="column"
          >
            <ScrollView
              ref={scroll}
              onContentHeightChange={() => {
                if (stick.current) scroll.current?.scrollToBottom();
              }}
            >
              {items.map((item, index) => (
                <Box key={index} flexDirection="column" paddingBottom={1}>
                  <Text>$ {item.command}</Text>
                  <Text color={item.status === "error" ? "red" : "gray"}>
                    {item.output.trimEnd()}
                  </Text>
                  {item.status !== "running" && (
                    <Text color="gray">
                      {item.exitCode === undefined ? item.status : `exit ${item.exitCode}`}
                    </Text>
                  )}
                </Box>
              ))}
            </ScrollView>
          </Box>
          <Divider />
          <MultilineInput
            value={input}
            onChange={setInput}
            onSubmit={() => void run()}
            submitDisabled={busy}
            placeholder="run a command..."
          />
          <Divider />
          <Box height={1}>
            {busy ? (
              <Spinner label="working..." />
            ) : (
              <Text color="gray">
                {cliTruncate(`session: ${sessionId} | qualifier: ${qualifier}`, columns)}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Layout>
  );
}
