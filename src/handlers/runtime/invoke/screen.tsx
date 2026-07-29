import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useWindowSize } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { InputValidationError } from "../../../errors";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { Layout } from "../../../components/Layout";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { darkTheme } from "../../../components/ui/_core.js";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import type { RuntimeInvokeResponse } from "../types";
import {
  normalizeRuntimeInvokeRequest,
  parseRuntimeInvokeHeaders,
  resolveRuntimeInvokeSources,
} from "./request";
import { RequestOptionsScreen, type RuntimeInvokeOptions } from "./RequestOptionsScreen";
import { RuntimePayloadInput } from "./RuntimePayloadInput";
import { classifyRuntimeResponse, writeRuntimeInvokeFile } from "./response";

const theme = darkTheme;

type ExchangeState = "connecting" | "streaming" | "complete" | "interrupted" | "failed";

type TargetPickerState = { stage: "runtime" } | { stage: "endpoint"; runtimeId: string };

interface Exchange {
  payload: string;
  response: string;
  pretty?: string;
  note?: string;
  heading?: string;
  metadata?: string;
  byteCount: number;
  state: ExchangeState;
}

const invokePath = (...parts: string[]) =>
  ["/agentcore/runtime/invoke", ...parts.map(encodeURIComponent)].join("/");

function optionsAfterTargetChange(
  options: RuntimeInvokeOptions,
  currentRuntimeId: string,
  nextRuntimeId: string,
): RuntimeInvokeOptions {
  const {
    runtimeSessionId: _runtimeSessionId,
    mcpSessionId: _mcpSessionId,
    ...withoutSessions
  } = options;
  if (currentRuntimeId === nextRuntimeId) return withoutSessions;

  const {
    bearerToken: _bearerToken,
    headers: _headers,
    ...withoutRuntimeCredentials
  } = withoutSessions;
  return withoutRuntimeCredentials;
}

function payloadPlaceholder(contentType?: string): string {
  const mediaType = (contentType || "application/json").split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "Enter JSON payload";
  if (mediaType.startsWith("text/")) return "Enter text payload";
  return "Enter payload";
}

const metadata = (response: RuntimeInvokeResponse) =>
  [
    ["Runtime", response.runtimeSessionId],
    ["MCP", response.mcpSessionId],
    ["MCP version", response.mcpProtocolVersion],
    ["trace", response.traceId],
    ["traceparent", response.traceParent],
    ["tracestate", response.traceState],
    ["baggage", response.baggage],
  ]
    .filter((entry) => entry[1])
    .map((entry) => entry.join(" "))
    .join(" · ");

export function RuntimeInvokeScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const navigate = useNavigate();

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
        onSelect={(selected) => navigate(invokePath(runtimeId, selected))}
        onEscape={() => navigate(invokePath())}
      />
    );
  }

  return <RuntimeInvokeConsole {...props} runtimeId={runtimeId} qualifier={qualifier} />;
}

type RuntimeInvokeConsoleProps = ScreenProps & { runtimeId: string; qualifier: string };

function RuntimeInvokeConsole({ ctx, core, runtimeId, qualifier }: RuntimeInvokeConsoleProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const { stdin } = useStdin();
  const { rows } = useWindowSize();
  const [target, setTarget] = useState({ runtimeId, qualifier });
  const [targetPicker, setTargetPicker] = useState<TargetPickerState | null>(null);
  const detail = useQuery({
    queryKey: ["runtime", opts.region, target.runtimeId],
    queryFn: ({ signal }) => core.runtime.getRuntime(target.runtimeId, opts, signal),
  });
  const customJwt =
    detail.data?.authorizerConfiguration !== undefined &&
    "customJWTAuthorizer" in detail.data.authorizerConfiguration;
  const mcp = detail.data?.protocolConfiguration?.serverProtocol === "MCP";
  const [payload, setPayload] = useState("");
  const [requestOptions, setRequestOptions] = useState<RuntimeInvokeOptions>({
    payloadSource: "Inline",
    responseDestination: "Console",
    contentType: "application/json",
  });
  const [showOptions, setShowOptions] = useState(false);
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
    stickRef.current = true;

    const {
      payloadSource,
      payloadPath,
      responseDestination,
      outputPath,
      headers,
      bearerToken,
      mcpSessionId,
      mcpProtocolVersion,
      mcpMethod,
      mcpName,
      ...modeled
    } = requestOptions;
    const requestPayload = payloadSource === "File" ? `file://${payloadPath ?? ""}` : payload;
    const appendExchange = (response: string, state: ExchangeState) =>
      setHistory((current) => [
        ...current,
        { payload: requestPayload, response, byteCount: 0, state },
      ]);
    if (responseDestination === "File" && !outputPath?.trim()) {
      appendExchange("Response path is required for File destination.", "failed");
      return;
    }
    setPayload("");
    appendExchange("", "connecting");
    setPrettyJson(false);
    const controller = new AbortController();
    abortRef.current = controller;
    let responseStarted = false;

    try {
      if (requestPayload === "-" || (customJwt && bearerToken === "-")) {
        throw new UsageError("stdin sources are not available in the interactive console");
      }
      const sources = await resolveRuntimeInvokeSources(
        { payload: requestPayload, bearerToken: customJwt ? bearerToken : undefined },
        stdin,
        controller.signal,
      );
      const request = normalizeRuntimeInvokeRequest(detail.data, {
        ...modeled,
        runtimeId: target.runtimeId,
        qualifier: target.qualifier,
        payload: sources.payload,
        applicationHeaders: parseRuntimeInvokeHeaders(headers?.split("\n").filter(Boolean)),
        bearerToken: sources.bearerToken,
        ...(mcp && { mcpSessionId, mcpProtocolVersion, mcpMethod, mcpName }),
      });
      const response = await core.runtime.invokeRuntime(request, opts, controller.signal);
      responseStarted = true;
      updateExchange({
        heading: `Response · ${response.statusCode} · ${response.contentType || "-"}`,
        metadata: metadata(response),
        state: "streaming",
      });
      let byteCount = 0;
      if (responseDestination === "File") {
        await writeRuntimeInvokeFile(response, outputPath!, controller.signal, (size) =>
          updateExchange({ byteCount: (byteCount += size) }),
        );
        updateExchange({ response: `Saved ${byteCount} bytes to ${outputPath}` });
      } else {
        const kind = classifyRuntimeResponse(response.contentType);
        if (kind === "binary") {
          controller.abort();
          updateExchange({
            response: "Binary or unknown response content requires File destination.",
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
      }
      setRequestOptions((current) => ({
        ...current,
        runtimeSessionId: response.runtimeSessionId ?? current.runtimeSessionId,
        mcpSessionId: response.mcpSessionId ?? current.mcpSessionId,
      }));
      updateExchange({ state: "complete" });
    } catch (error) {
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") {
        updateExchange({ note: "interrupted", state: "interrupted" });
        } else if (error instanceof InputValidationError) {
        updateExchange({ response: `Error: ${error.message}`, state: "failed" });
      } else if (!responseStarted && error instanceof Error) {
        updateExchange({ note: error.message, state: "failed" });
      } else {
        updateExchange({ note: "response stream failed", state: "failed" });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const liveState = history.at(-1)?.state;
  const busy = liveState === "connecting" || liveState === "streaming";
  const inputRows = Math.min(4, Math.max(1, payload.split("\n").length));
  const canPrettyJson = history.some((exchange) => exchange.pretty !== undefined);
  const contentType = requestOptions.contentType || "application/json";

  useInput(
    (input, key) => {
      if (key.ctrl) {
        if (input === "o" && !abortRef.current) setShowOptions(true);
        else if (input === "v" && !abortRef.current) setPrettyJson((current) => !current);
        else if (input === "t" && !abortRef.current) setTargetPicker({ stage: "runtime" });
        else if (input === "d") void send();
        return;
      }
      if (key.escape) {
        if (abortRef.current) abortRef.current.abort();
        else navigate(invokePath(target.runtimeId));
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
    { isActive: !showOptions && targetPicker === null },
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
            setTarget({ runtimeId: nextRuntimeId, qualifier: selected });
            setRequestOptions((current) =>
              optionsAfterTargetChange(current, target.runtimeId, nextRuntimeId),
            );
            setHistory([]);
            setPrettyJson(false);
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
        showOptions
          ? [{ key: "esc", label: "back" }]
          : busy
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
                { key: "ctl+o", label: "options" },
                { key: "ctl+t", label: "target" },
                { key: "↑↓", label: "scroll" },
                { key: "esc", label: "back" },
                { key: "ctl+c", label: "quit" },
              ]
      }
    >
      {detail.isPending ? (
        <Spinner label="Loading Runtime…" />
      ) : detail.isError ? (
        <Text color="red">Error: {(detail.error as Error).message}</Text>
      ) : showOptions ? (
        <RequestOptionsScreen
          value={requestOptions}
          onChange={setRequestOptions}
          onClose={() => setShowOptions(false)}
          customJwt={customJwt}
          mcp={mcp}
        />
      ) : (
        <Box flexDirection="column">
          <Box height={Math.max(1, rows - 8 - inputRows)} flexDirection="column">
            <ScrollView ref={scrollRef} onContentHeightChange={keepScrolledToBottom}>
              {history.map((exchange, index) => (
                <Box key={index} flexDirection="column" paddingBottom={1}>
                  <Text bold>Request</Text>
                  <Text>{exchange.payload}</Text>
                  <Text bold>{exchange.heading ?? "Response"}</Text>
                  <Text>{prettyJson && exchange.pretty ? exchange.pretty : exchange.response}</Text>
                  {exchange.metadata ? <Text color="gray">{exchange.metadata}</Text> : null}
                  {exchange.note ? <Text color="yellow">{exchange.note}</Text> : null}
                  <Text color={exchange.state === "failed" ? "red" : "gray"}>
                    {exchange.state} · {exchange.byteCount} bytes
                  </Text>
                </Box>
              ))}
            </ScrollView>
          </Box>
          <Divider />
          <RuntimePayloadInput
            label={`Payload · ${contentType}`}
            placeholder={payloadPlaceholder(contentType)}
            value={payload}
            onChange={setPayload}
            onSubmit={() => void send()}
            submitDisabled={busy}
            previewLines={4}
          />
          <Divider />
          <Box height={1}>
            {busy ? (
              <Spinner label={`${liveState}… (esc to interrupt)`} />
            ) : (
              <Text color={theme.colors.muted}>
                idle · Sessions: Runtime {requestOptions.runtimeSessionId ?? "new"} · MCP{" "}
                {requestOptions.mcpSessionId ?? "new"}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Layout>
  );
}
