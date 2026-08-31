import { randomUUID } from "node:crypto";
import { ServiceException } from "@smithy/core/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import cliTruncate from "cli-truncate";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { darkTheme } from "../../../components/ui/_core.js";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import type { RuntimeInvokeResponse } from "../types";
import { normalizeRuntimeInvokeRequest } from "./request";
import { classifyRuntimeResponse } from "./response";
import { RuntimeInvokeLaunchContextKey, type RuntimeInvokeLaunchContext } from "./launchContext";

const theme = darkTheme;

type ExchangeState = "connecting" | "streaming" | "complete" | "interrupted" | "failed";

type TargetPickerState = { stage: "runtime" } | { stage: "endpoint"; runtimeId: string };

type RuntimeInvokeLocationState = {
  returnOnEscape?: boolean;
};

type ErrorDetails = {
  name: string;
  message?: string;
  statusCode?: number;
  requestId?: string;
};

type Exchange = {
  payload: string;
  response: string;
  error?: ErrorDetails;
  pretty?: string;
  note?: string;
  heading?: string;
  metadata?: string;
  byteCount: number;
  state: ExchangeState;
};

const invokePath = (...parts: string[]) =>
  ["/agentcore/runtime/invoke", ...parts.map(encodeURIComponent)].join("/");

const metadata = (response: RuntimeInvokeResponse) =>
  [
    ["Session ID:", response.runtimeSessionId],
    ["MCP session ID:", response.mcpSessionId],
    ["MCP protocol version:", response.mcpProtocolVersion],
    ["trace", response.traceId],
    ["traceparent", response.traceParent],
    ["tracestate", response.traceState],
    ["baggage", response.baggage],
  ]
    .filter((entry) => entry[1])
    .map((entry) => entry.join(" "))
    .join(" · ");

function errorDetails(error: unknown): ErrorDetails {
  const reported = error instanceof Error ? error : new Error(String(error));
  const display = ServiceException.isInstance(reported.cause) ? reported.cause : reported;
  return {
    name: display.name,
    message: display.message || undefined,
    ...(ServiceException.isInstance(display) && {
      statusCode: display.$metadata.httpStatusCode,
      requestId: display.$metadata.requestId,
    }),
  };
}

function ErrorBlock({ details }: { details: ErrorDetails }) {
  return (
    <Box flexDirection="column">
      <Text color="red">
        {details.name}
        {details.statusCode ? ` · HTTP ${details.statusCode}` : ""}
      </Text>
      {details.message ? <Text>{details.message}</Text> : null}
      {details.requestId ? <Text color="gray">Request ID: {details.requestId}</Text> : null}
    </Box>
  );
}

export function RuntimeInvokeScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const launchContext = props.ctx.value(RuntimeInvokeLaunchContextKey);
  const initialContext = launchContext?.runtimeId === runtimeId ? launchContext : undefined;
  const returnOnEscape = (location.state as RuntimeInvokeLocationState | null)?.returnOnEscape;

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "invoke"]}
        description="choose a Runtime to invoke"
        onSelect={(id) => navigate(invokePath(id))}
      />
    );
  }

  if (!qualifier) {
    return (
      <RuntimeEndpointPicker
        {...props}
        runtimeId={runtimeId}
        breadcrumb={["agentcore", "runtime", "invoke", runtimeId]}
        description="choose an endpoint to invoke"
        onSelect={(selected) =>
          navigate(invokePath(runtimeId, selected), {
            replace: returnOnEscape === true,
            state: returnOnEscape ? { returnOnEscape } : undefined,
          })
        }
        onEscape={() => (returnOnEscape ? navigate(-1) : navigate(invokePath()))}
      />
    );
  }

  return (
    <RuntimeInvokeConsole
      {...props}
      runtimeId={runtimeId}
      qualifier={qualifier}
      initialContext={initialContext}
      returnOnEscape={returnOnEscape}
    />
  );
}

export type RuntimeInvokeConsoleProps = ScreenProps & {
  runtimeId: string;
  qualifier: string;
  initialContext?: RuntimeInvokeLaunchContext;
  returnOnEscape?: boolean;
  onBack?: () => void;
};

export function RuntimeInvokeConsole({
  ctx,
  core,
  runtimeId,
  qualifier,
  initialContext,
  returnOnEscape,
  onBack,
}: RuntimeInvokeConsoleProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const { columns, rows } = useWindowSize();
  const [target, setTarget] = useState({ runtimeId, qualifier });
  const [targetPicker, setTargetPicker] = useState<TargetPickerState | null>(null);
  const detail = useQuery({
    queryKey: ["runtime", opts.region, target.runtimeId],
    queryFn: ({ signal }) => core.runtime.getRuntime(target.runtimeId, opts, signal),
  });
  const mcp = detail.data?.protocolConfiguration?.serverProtocol === "MCP";
  const [payload, setPayload] = useState("");
  const [inputError, setInputError] = useState<string>();
  const [requestContext, setRequestContext] = useState(initialContext);
  const [runtimeSessionId, setRuntimeSessionId] = useState(
    () => initialContext?.runtimeSessionId ?? randomUUID(),
  );
  const [mcpSessionId, setMcpSessionId] = useState<string>();
  const [mcpProtocolVersion, setMcpProtocolVersion] = useState<string>();
  const [history, setHistory] = useState<Exchange[]>([]);
  const [prettyJson, setPrettyJson] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);
  const stickRef = useRef(true);
  const keepScrolledToBottom = useCallback(() => {
    if (stickRef.current) scrollRef.current?.scrollToBottom();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateExchange = (patch: Partial<Exchange>) => {
    setHistory((current) => current.slice(0, -1).concat({ ...current.at(-1)!, ...patch }));
  };

  const send = async () => {
    if (abortRef.current || !detail.data) return;
    const requestPayload = payload;
    try {
      JSON.parse(requestPayload);
    } catch {
      setInputError("Enter a valid JSON payload");
      return;
    }

    setInputError(undefined);
    stickRef.current = true;
    const appendExchange = (response: string, state: ExchangeState) =>
      setHistory((current) => [
        ...current,
        { payload: requestPayload, response, byteCount: 0, state },
      ]);
    setPayload("");
    appendExchange("", "connecting");
    setPrettyJson(false);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const request = normalizeRuntimeInvokeRequest(detail.data, {
        runtimeId: target.runtimeId,
        qualifier: target.qualifier,
        payload: new TextEncoder().encode(requestPayload),
        contentType: "application/json",
        runtimeSessionId,
        runtimeUserId: requestContext?.runtimeUserId,
        applicationHeaders: requestContext?.applicationHeaders,
        bearerToken: requestContext?.bearerToken,
        ...(mcp && { mcpSessionId, mcpProtocolVersion }),
      });
      const response = await core.runtime.invokeRuntime(request, opts, controller.signal);
      updateExchange({
        heading: `Response · ${response.statusCode} · ${response.contentType || "-"}`,
        metadata: metadata(response),
        state: "streaming",
      });
      let byteCount = 0;
      const kind = classifyRuntimeResponse(response.contentType);
      if (kind === "binary") {
        controller.abort();
        updateExchange({
          response: "Binary or unknown responses require headless invoke with --output-file.",
          state: "failed",
        });
        return;
      }
      const decoder = new TextDecoder();
      const chunks: Uint8Array[] = [];
      let responseText = "";
      for await (const chunk of response.body) {
        const snapshot = Uint8Array.from(chunk);
        chunks.push(snapshot);
        byteCount += snapshot.byteLength;
        responseText += decoder.decode(snapshot, { stream: true });
        updateExchange({
          response: responseText,
          byteCount,
        });
      }
      responseText += decoder.decode();
      updateExchange({ response: responseText });
      let text: string | undefined;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        updateExchange({ note: "Invalid UTF-8 response; showing raw text." });
      }
      if (kind === "json" && text !== undefined) {
        try {
          const pretty = JSON.stringify(JSON.parse(text), null, 2);
          updateExchange({ pretty });
        } catch {
          updateExchange({ note: "Invalid JSON response; showing raw text." });
        }
      }
      if (response.runtimeSessionId) setRuntimeSessionId(response.runtimeSessionId);
      if (response.mcpSessionId) setMcpSessionId(response.mcpSessionId);
      if (response.mcpProtocolVersion) setMcpProtocolVersion(response.mcpProtocolVersion);
      updateExchange({ state: "complete" });
    } catch (error) {
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") {
        updateExchange({ note: "interrupted", state: "interrupted" });
      } else {
        updateExchange({ error: errorDetails(error), state: "failed" });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const liveState = history.at(-1)?.state;
  const busy = liveState === "connecting" || liveState === "streaming";
  const inputRows = Math.min(4, Math.max(1, payload.split("\n").length));
  const transcriptHeight = Math.max(1, rows - 7 - inputRows);
  const canPrettyJson = history.some((exchange) => exchange.pretty !== undefined);
  const requestContextSummary = [
    requestContext?.runtimeUserId ? "user" : undefined,
    requestContext?.bearerToken ? "JWT" : undefined,
    requestContext?.applicationHeaders?.length
      ? `${requestContext.applicationHeaders.length}h`
      : undefined,
  ]
    .filter(Boolean)
    .join("/");

  useInput(
    (input, key) => {
      if (key.ctrl) {
        if (input === "v" && !abortRef.current) setPrettyJson((current) => !current);
        else if (input === "t" && !abortRef.current) setTargetPicker({ stage: "runtime" });
        return;
      }
      if (key.escape) {
        if (abortRef.current) abortRef.current.abort();
        else if (onBack) onBack();
        else if (returnOnEscape) navigate(-1);
        else setTargetPicker({ stage: "endpoint", runtimeId: target.runtimeId });
        return;
      }
      const view = scrollRef.current;
      if (!view) return;
      if (key.upArrow) {
        const offset = view.getScrollOffset();
        const next = Math.max(0, offset - 1);
        view.scrollTo(next);
        if (next < view.getBottomOffset()) stickRef.current = false;
      }
      if (key.downArrow) {
        const offset = view.getScrollOffset();
        const bottom = view.getBottomOffset();
        const next = Math.min(bottom, offset + 1);
        view.scrollTo(next);
        if (next >= bottom) stickRef.current = true;
      }
    },
    { isActive: targetPicker === null },
  );

  if (targetPicker?.stage === "runtime") {
    return (
      <RuntimePicker
        ctx={ctx}
        core={core}
        breadcrumb={["agentcore", "runtime", "invoke"]}
        description="choose another Runtime"
        onSelect={(selectedRuntimeId) =>
          setTargetPicker({ stage: "endpoint", runtimeId: selectedRuntimeId })
        }
        onEscape={() => setTargetPicker(null)}
      />
    );
  }

  if (targetPicker?.stage === "endpoint") {
    const nextRuntimeId = targetPicker.runtimeId;
    return (
      <RuntimeEndpointPicker
        ctx={ctx}
        core={core}
        runtimeId={nextRuntimeId}
        breadcrumb={["agentcore", "runtime", "invoke", nextRuntimeId]}
        description="choose another endpoint"
        onSelect={(selected) => {
          if (nextRuntimeId !== target.runtimeId || selected !== target.qualifier) {
            const runtimeChanged = nextRuntimeId !== target.runtimeId;
            setTarget({ runtimeId: nextRuntimeId, qualifier: selected });
            setRuntimeSessionId(randomUUID());
            setMcpSessionId(undefined);
            setMcpProtocolVersion(undefined);
            if (runtimeChanged) setRequestContext(undefined);
            setHistory([]);
            setPrettyJson(false);
            setInputError(undefined);
          }
          setTargetPicker(null);
        }}
        onEscape={() => setTargetPicker({ stage: "runtime" })}
      />
    );
  }

  return (
    <Layout
      breadcrumb={["agentcore", "runtime", "invoke", target.runtimeId, target.qualifier]}
      keyHints={
        busy
          ? [
              { key: "esc", label: "interrupt" },
              { key: "↑↓", label: "scroll" },
              { key: "ctl+c", label: "quit" },
            ]
          : [
              { key: "enter", label: "send" },
              ...(canPrettyJson
                ? [
                    {
                      key: "ctl+v",
                      label: prettyJson ? "raw JSON" : "pretty JSON",
                    },
                  ]
                : [{ key: "⇧↵", label: "newline" }]),
              { key: "ctl+t", label: "target" },
              { key: "↑↓", label: "scroll" },
              { key: "esc", label: "back" },
              { key: "ctl+c", label: "quit" },
            ]
      }
    >
      <Box height="100%" flexDirection="column">
        {detail.isPending ? (
          <Spinner label="Loading Runtime…" />
        ) : detail.isError ? (
          <ErrorBlock details={errorDetails(detail.error)} />
        ) : (
          <Box flexDirection="column">
            <Box height={transcriptHeight} flexDirection="column">
              <ScrollView ref={scrollRef} onContentHeightChange={keepScrolledToBottom}>
                {history.map((exchange, index) => (
                  <Box key={index} flexDirection="column" paddingBottom={1}>
                    <Text bold>Request</Text>
                    <Text>{exchange.payload}</Text>
                    <Text bold>{exchange.heading ?? "Response"}</Text>
                    <Text>
                      {(prettyJson && exchange.pretty
                        ? exchange.pretty
                        : exchange.response
                      ).replace(/[\r\n]+$/, "")}
                    </Text>
                    {exchange.state !== "connecting" && exchange.state !== "streaming" ? (
                      <>
                        {exchange.metadata ? <Text color="gray">{exchange.metadata}</Text> : null}
                        {exchange.error ? <ErrorBlock details={exchange.error} /> : null}
                        {exchange.note ? <Text color="yellow">{exchange.note}</Text> : null}
                        <Text color={exchange.state === "failed" ? "red" : "gray"}>
                          {exchange.state} · {exchange.byteCount} bytes
                        </Text>
                      </>
                    ) : null}
                  </Box>
                ))}
              </ScrollView>
            </Box>
            <Divider />
            <MultilineInput
              value={payload}
              onChange={(value) => {
                setPayload(value);
                setInputError(undefined);
              }}
              onSubmit={() => void send()}
              placeholder="Enter JSON payload"
              submitDisabled={busy}
            />
            <Divider />
            <Box height={1}>
              {inputError ? (
                <Text color="red">{inputError}</Text>
              ) : busy ? (
                <Spinner label={`${liveState}… (esc to interrupt)`} />
              ) : (
                <Text color={theme.colors.muted}>
                  {cliTruncate(
                    `Ready · Session ID: ${runtimeSessionId ?? "Not set"}${
                      mcp ? ` · MCP session ID: ${mcpSessionId ?? "Not set"}` : ""
                    }${requestContextSummary ? ` · Context ${requestContextSummary}` : ""}`,
                    columns,
                  )}
                </Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Layout>
  );
}
