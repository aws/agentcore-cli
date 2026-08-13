import { randomUUID } from "node:crypto";
import { ServiceException } from "@smithy/core/client";
import { useQuery } from "@tanstack/react-query";
import cliTruncate from "cli-truncate";
import { Box, Text, useInput, useWindowSize } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { GatewayPicker } from "../../../components/GatewayPicker";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { darkTheme } from "../../../components/ui/_core.js";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import { TextInput } from "../../../components/ui/text-input";
import { classifyStreamingResponse } from "../../../io";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { GatewayInvokeRequest, GatewayInvokeResponse } from "../types";
import { GatewayInvokeLaunchContextKey, type GatewayInvokeLaunchContext } from "./launchContext";
import { normalizeGatewayInvokeRequest } from "./request";

const theme = darkTheme;
const ACCEPT = "application/json, text/event-stream, */*;q=0.1";

type ExchangeState = "connecting" | "streaming" | "complete" | "interrupted" | "failed";

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
  ["/agentcore/gateway/invoke", ...parts.map(encodeURIComponent)].join("/");

const metadata = (response: GatewayInvokeResponse) =>
  [
    ["Runtime session ID:", response.runtimeSessionId],
    ["MCP session ID:", response.mcpSessionId],
    ["MCP protocol version:", response.mcpProtocolVersion],
    ["Request ID:", response.requestId],
  ]
    .filter((entry) => entry[1])
    .map((entry) => entry.join(" "))
    .join(" · ");

function displayPath(path: string, gatewayUrl?: string): string {
  if (path) return path;
  try {
    const url = new URL(gatewayUrl ?? "");
    return `${url.pathname || "/"}${url.search} (Gateway URL)`;
  } catch {
    return "Gateway URL";
  }
}

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
      <Text color={theme.colors.error}>
        {details.name}
        {details.statusCode ? ` · HTTP ${details.statusCode}` : ""}
      </Text>
      {details.message ? <Text>{details.message}</Text> : null}
      {details.requestId ? (
        <Text color={theme.colors.muted}>Request ID: {details.requestId}</Text>
      ) : null}
    </Box>
  );
}

function PathEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { columns } = useWindowSize();
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
      <Box
        width={Math.max(32, Math.min(72, columns - 4))}
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.border}
        backgroundColor="black"
        paddingX={1}
        paddingY={1}
      >
        <Text bold color={theme.colors.primary}>
          Edit path
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSave}
          placeholder="Use Gateway URL"
          prompt="Path: "
        />
      </Box>
    </Box>
  );
}

export function GatewayInvokeScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const navigate = useNavigate();
  const launchContext = props.ctx.value(GatewayInvokeLaunchContextKey);
  const initialContext = launchContext?.gatewayId === gatewayId ? launchContext : undefined;

  if (!gatewayId) {
    return (
      <GatewayPicker
        {...props}
        breadcrumb={["agentcore", "gateway", "invoke"]}
        description="choose a Gateway to invoke"
        onSelect={(id) => navigate(invokePath(id))}
      />
    );
  }

  return <GatewayInvokeConsole {...props} gatewayId={gatewayId} initialContext={initialContext} />;
}

type GatewayInvokeConsoleProps = ScreenProps & {
  gatewayId: string;
  initialContext?: GatewayInvokeLaunchContext;
};

function GatewayInvokeConsole({ ctx, core, gatewayId, initialContext }: GatewayInvokeConsoleProps) {
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(ctx);
  const { columns, rows } = useWindowSize();
  const [targetGatewayId, setTargetGatewayId] = useState(gatewayId);
  const [pickingGateway, setPickingGateway] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [path, setPath] = useState(initialContext?.path ?? "");
  const [pathDraft, setPathDraft] = useState(path);
  const [payload, setPayload] = useState("");
  const [inputError, setInputError] = useState<string>();
  const [requestContext, setRequestContext] = useState(initialContext);
  const [runtimeSessionId, setRuntimeSessionId] = useState(
    () => initialContext?.runtimeSessionId ?? randomUUID(),
  );
  const [mcpSessionId, setMcpSessionId] = useState(initialContext?.mcpSessionId);
  const [mcpProtocolVersion, setMcpProtocolVersion] = useState(initialContext?.mcpProtocolVersion);
  const [history, setHistory] = useState<Exchange[]>([]);
  const [prettyJson, setPrettyJson] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);
  const stickRef = useRef(true);
  const detail = useQuery({
    queryKey: ["gateway", opts.region, targetGatewayId],
    queryFn: ({ signal }) => core.gateway.getGateway(targetGatewayId, opts, signal),
  });
  const missingBearerToken =
    detail.data?.authorizerType === "CUSTOM_JWT" && !requestContext?.bearerToken;
  const unavailableStatus =
    detail.data?.status !== undefined && detail.data.status !== "READY"
      ? detail.data.status
      : undefined;

  const keepScrolledToBottom = useCallback(() => {
    if (stickRef.current) scrollRef.current?.scrollToBottom();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateExchange = (patch: Partial<Exchange>) => {
    setHistory((current) => current.slice(0, -1).concat({ ...current.at(-1)!, ...patch }));
  };

  const send = async () => {
    if (abortRef.current || !detail.data || missingBearerToken || unavailableStatus) return;
    const requestPayload = payload;
    try {
      JSON.parse(requestPayload);
    } catch {
      setInputError("Enter a valid JSON payload");
      return;
    }

    let request: GatewayInvokeRequest;
    try {
      request = normalizeGatewayInvokeRequest(detail.data, {
        gatewayId: targetGatewayId,
        path: path || undefined,
        method: "POST",
        payload: new TextEncoder().encode(requestPayload),
        contentType: "application/json",
        accept: ACCEPT,
        applicationHeaders: requestContext?.applicationHeaders,
        bearerToken: requestContext?.bearerToken,
        runtimeSessionId,
        mcpSessionId,
        mcpProtocolVersion,
      });
    } catch (error) {
      const details = errorDetails(error);
      setInputError(details.message ?? details.name);
      return;
    }

    setInputError(undefined);
    stickRef.current = true;
    setPayload("");
    setHistory((current) => [
      ...current,
      { payload: requestPayload, response: "", byteCount: 0, state: "connecting" },
    ]);
    setPrettyJson(false);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await core.gateway.invokeGateway(request, opts, controller.signal);
      updateExchange({
        heading: `Response · ${response.statusCode} · ${response.contentType || "-"}`,
        metadata: metadata(response),
        state: "streaming",
      });
      const kind = classifyStreamingResponse(response.contentType);
      if (response.statusCode !== 204 && response.statusCode !== 205 && kind === "binary") {
        controller.abort();
        updateExchange({
          response: "Binary or unknown responses require headless invoke with --output-file.",
          state: "failed",
        });
        return;
      }

      let byteCount = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let responseText = "";
      for await (const chunk of response.body) {
        const snapshot = Uint8Array.from(chunk);
        byteCount += snapshot.byteLength;
        try {
          responseText += decoder.decode(snapshot, { stream: true });
        } catch {
          controller.abort();
          updateExchange({
            response: responseText,
            byteCount,
            note: "Non-renderable responses require headless invoke with --output-file.",
            state: "failed",
          });
          return;
        }
        updateExchange({ response: responseText, byteCount });
      }
      try {
        responseText += decoder.decode();
      } catch {
        controller.abort();
        updateExchange({
          response: responseText,
          byteCount,
          note: "Non-renderable responses require headless invoke with --output-file.",
          state: "failed",
        });
        return;
      }
      updateExchange({ response: responseText });

      if (kind === "json") {
        try {
          updateExchange({ pretty: JSON.stringify(JSON.parse(responseText), null, 2) });
        } catch {
          updateExchange({ note: "Invalid JSON response; showing raw text." });
        }
      }

      const success = response.statusCode >= 200 && response.statusCode < 300;
      if (response.runtimeSessionId) setRuntimeSessionId(response.runtimeSessionId);
      if (response.mcpSessionId) setMcpSessionId(response.mcpSessionId);
      if (response.mcpProtocolVersion) setMcpProtocolVersion(response.mcpProtocolVersion);
      updateExchange({
        ...(success ? {} : { note: `HTTP ${response.statusCode}` }),
        state: success ? "complete" : "failed",
      });
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

  const resetSessions = () => {
    setRuntimeSessionId(randomUUID());
    setMcpSessionId(undefined);
    setMcpProtocolVersion(undefined);
  };

  const savePath = () => {
    if (pathDraft !== path) {
      setPath(pathDraft);
      resetSessions();
      setHistory([]);
      setPrettyJson(false);
      setInputError(undefined);
    }
    setEditingPath(false);
  };

  const selectGateway = (selectedGatewayId: string) => {
    if (selectedGatewayId !== targetGatewayId) {
      setTargetGatewayId(selectedGatewayId);
      setPath("");
      setPathDraft("");
      setPayload("");
      setRequestContext(undefined);
      resetSessions();
      setHistory([]);
      setPrettyJson(false);
      setInputError(undefined);
    }
    setPickingGateway(false);
  };

  const liveState = history.at(-1)?.state;
  const busy = liveState === "connecting" || liveState === "streaming";
  const inputRows = Math.min(4, Math.max(1, payload.split("\n").length));
  const transcriptHeight = Math.max(1, rows - 8 - inputRows);
  const canPrettyJson = history.some((exchange) => exchange.pretty !== undefined);
  const requestContextSummary = [
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
        else if (input === "t" && !abortRef.current) setPickingGateway(true);
        else if (input === "p" && !abortRef.current) {
          setPathDraft(path);
          setEditingPath(true);
        }
        return;
      }
      if (key.escape) {
        if (abortRef.current) abortRef.current.abort();
        else navigate(invokePath());
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
    { isActive: !pickingGateway && !editingPath },
  );

  if (pickingGateway) {
    return (
      <GatewayPicker
        ctx={ctx}
        core={core}
        breadcrumb={["agentcore", "gateway", "invoke"]}
        description="choose another Gateway"
        onSelect={selectGateway}
        onEscape={() => setPickingGateway(false)}
      />
    );
  }

  return (
    <Layout
      breadcrumb={["agentcore", "gateway", "invoke", targetGatewayId]}
      keyHints={
        editingPath
          ? [
              { key: "enter", label: "save" },
              { key: "esc", label: "cancel" },
              { key: "ctl+c", label: "quit" },
            ]
          : busy
            ? [
                { key: "esc", label: "interrupt" },
                { key: "↑↓", label: "scroll" },
                { key: "ctl+c", label: "quit" },
              ]
            : [
                { key: "enter", label: "send" },
                ...(canPrettyJson
                  ? [{ key: "ctl+v", label: prettyJson ? "raw JSON" : "pretty JSON" }]
                  : [{ key: "⇧↵", label: "newline" }]),
                { key: "ctl+p", label: "path" },
                { key: "ctl+t", label: "gateway" },
                { key: "↑↓", label: "scroll" },
                { key: "esc", label: "back" },
                { key: "ctl+c", label: "quit" },
              ]
      }
    >
      <Box height="100%" flexDirection="column" position="relative">
        {detail.isPending ? (
          <Spinner label="Loading Gateway…" />
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
                        {exchange.metadata ? (
                          <Text color={theme.colors.muted}>{exchange.metadata}</Text>
                        ) : null}
                        {exchange.error ? <ErrorBlock details={exchange.error} /> : null}
                        {exchange.note ? (
                          <Text color={theme.colors.warning}>{exchange.note}</Text>
                        ) : null}
                        <Text
                          color={
                            exchange.state === "failed" ? theme.colors.error : theme.colors.muted
                          }
                        >
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
              submitDisabled={busy || missingBearerToken || unavailableStatus !== undefined}
              focus={!editingPath}
            />
            <Divider />
            <Box height={2} flexDirection="column">
              {inputError ? (
                <Text color={theme.colors.error}>{inputError}</Text>
              ) : missingBearerToken ? (
                <Text color={theme.colors.error}>
                  CUSTOM_JWT Gateway requires --bearer-token; relaunch with the flag.
                </Text>
              ) : unavailableStatus ? (
                <Text color={theme.colors.error}>
                  Gateway is {unavailableStatus}; invocation requires READY.
                </Text>
              ) : busy ? (
                <Spinner label={`${liveState}… (esc to interrupt)`} />
              ) : (
                <>
                  <Text color={theme.colors.muted}>
                    {cliTruncate(
                      `Ready · Runtime session ID: ${runtimeSessionId} · Path: ${displayPath(
                        path,
                        detail.data?.gatewayUrl,
                      )}`,
                      columns,
                    )}
                  </Text>
                  <Text color={theme.colors.muted}>
                    {cliTruncate(
                      `Auth: ${detail.data?.authorizerType ?? "-"}` +
                        `${requestContextSummary ? ` · Context: ${requestContextSummary}` : ""}` +
                        `${mcpSessionId ? ` · MCP session ID: ${mcpSessionId}` : ""}`,
                      columns,
                    )}
                  </Text>
                </>
              )}
            </Box>
          </Box>
        )}
        {editingPath ? (
          <PathEditor
            value={pathDraft}
            onChange={setPathDraft}
            onSave={savePath}
            onCancel={() => setEditingPath(false)}
          />
        ) : null}
      </Box>
    </Layout>
  );
}
