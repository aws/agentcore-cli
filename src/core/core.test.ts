import { test, expect } from "bun:test";
import {
  GetAgentRuntimeCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import {
  GetEventCommand,
  GetMemoryRecordCommand,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
  InvokeHarnessCommand,
  ListActorsCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  ListSessionsCommand,
  ValidationException,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import type { RuntimeInvokeRequest } from "../handlers/runtime/types";
import type { Logger, LoggerBindings } from "../logging";
import { CoreClient } from "./index";
import type { ClientConfig, CoreFetch } from "./types";
import { toClientConfig } from "./utils";
import { createSilentLogger } from "../testing";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  bindings: LoggerBindings;
}

function captureLogs(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const makeLogger = (bindings: LoggerBindings): Logger => {
    const log =
      (level: CapturedLog["level"]) =>
      (...messages: string[]) =>
        logs.push({ level, message: messages.join(" "), bindings });
    return {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      child: (childBindings) => makeLogger({ ...bindings, ...childBindings }),
    };
  };
  return { logger: makeLogger({}), logs };
}

function expectSafeDebugLog(
  logs: CapturedLog[],
  message: string,
  bindings: LoggerBindings,
  secrets: string[],
): void {
  expect(logs).toEqual([
    {
      level: "debug",
      message,
      bindings: { module: "runtime", operation: "invokeRuntime", ...bindings },
    },
  ]);
  const serialized = JSON.stringify(logs);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

// A minimal stand-in for the SDK clients; CoreClient only stores and returns
// them, so an opaque tagged object is enough to assert identity/caching.
function fakeControl(config: ClientConfig): BedrockAgentCoreControlClient {
  return { config, kind: "control" } as unknown as BedrockAgentCoreControlClient;
}
function fakeData(config: ClientConfig): BedrockAgentCoreClient {
  return { config, kind: "data" } as unknown as BedrockAgentCoreClient;
}
function fakeIam(config: ClientConfig): IAMClient {
  return { config, kind: "iam" } as unknown as IAMClient;
}
function fakeLogs(config: ClientConfig): CloudWatchLogsClient {
  return { config, kind: "logs" } as unknown as CloudWatchLogsClient;
}

function coreWithDataSend(
  send: (command: unknown, options: unknown) => Promise<unknown>,
  logger: Logger = createSilentLogger(),
): CoreClient {
  return new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) =>
      ({ config, kind: "data", send }) as unknown as BedrockAgentCoreClient,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger,
  });
}

async function resolveRuntimeApplicationHeaders(
  command: InvokeAgentRuntimeCommand,
): Promise<[string, string][]> {
  let headers: [string, string][] = [];
  const handler = command.middlewareStack.resolve(async (args) => {
    headers = Object.entries((args.request as { headers: Record<string, string> }).headers);
    return { output: { statusCode: 204 } as never, response: {} as never };
  }, {} as never);
  await handler({ input: command.input, request: { headers: {} } } as never);
  return headers;
}

function customJwtCore(
  fetch: CoreFetch,
  {
    endpoint = "https://runtime.test",
    logger = createSilentLogger(),
  }: { endpoint?: string; logger?: Logger } = {},
): CoreClient {
  return new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) =>
      ({
        config: {
          endpointProvider: () => ({ url: new URL(config.endpoint ?? endpoint) }),
        },
        send: async () => {
          throw new Error("IAM transport must not be used");
        },
      }) as unknown as BedrockAgentCoreClient,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    fetch,
    logger,
  });
}

test("control() constructs a client once per config and caches it", () => {
  let built = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      built++;
      return fakeControl(config);
    },
    createDataClient: fakeData,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });

  const a = core.control({ region: "us-east-1" });
  const b = core.control({ region: "us-east-1" });

  expect(a).toBe(b);
  expect(built).toBe(1);
});

test("control() builds a distinct client per distinct config", () => {
  let built = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      built++;
      return fakeControl(config);
    },
    createDataClient: fakeData,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });

  core.control({ region: "us-east-1" });
  core.control({ region: "us-west-2" });
  core.control({ region: "us-east-1", endpoint: "https://example" });

  expect(built).toBe(3);
});

test("data() caches independently of control()", () => {
  let controlBuilt = 0;
  let dataBuilt = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      controlBuilt++;
      return fakeControl(config);
    },
    createDataClient: (config) => {
      dataBuilt++;
      return fakeData(config);
    },
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });

  core.control({ region: "us-east-1" });
  const d1 = core.data({ region: "us-east-1" });
  const d2 = core.data({ region: "us-east-1" });

  expect(d1).toBe(d2);
  expect(controlBuilt).toBe(1);
  expect(dataBuilt).toBe(1);
});

test("exposes feature sub-clients", () => {
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: fakeData,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });
  expect(core.harness).toBeDefined();
  expect(core.memory).toBeDefined();
  expect(core.gateway).toBeDefined();
  expect(core.observability).toBeDefined();
});

test("getEvent sends a GetEventCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { event: undefined };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    actorId: "actor-123",
    sessionId: "session-123",
    eventId: "event-123",
  };

  const result = await core.memory.getEvent(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(GetEventCommand);
  expect((sent[0] as GetEventCommand).input).toEqual(input);
});

test("listEvents sends a ListEventsCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { events: [], nextToken: "next" };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    actorId: "actor-123",
    sessionId: "session-123",
    includePayloads: true,
    maxResults: 25,
    nextToken: "current",
  };

  const result = await core.memory.listEvents(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(ListEventsCommand);
  expect((sent[0] as ListEventsCommand).input).toEqual(input);
});

test("listActors sends a ListActorsCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { actorSummaries: [], nextToken: "next" };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    maxResults: 25,
    nextToken: "current",
  };

  const result = await core.memory.listActors(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(ListActorsCommand);
  expect((sent[0] as ListActorsCommand).input).toEqual(input);
});

test("listSessions sends a ListSessionsCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { sessionSummaries: [], nextToken: "next" };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    actorId: "actor-123",
    maxResults: 25,
    nextToken: "current",
  };

  const result = await core.memory.listSessions(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(ListSessionsCommand);
  expect((sent[0] as ListSessionsCommand).input).toEqual(input);
});

test("getMemoryRecord sends a GetMemoryRecordCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { memoryRecord: undefined };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    memoryRecordId: "record-123",
  };

  const result = await core.memory.getMemoryRecord(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(GetMemoryRecordCommand);
  expect((sent[0] as GetMemoryRecordCommand).input).toEqual(input);
});

test("listMemoryRecords sends a ListMemoryRecordsCommand on the data client", async () => {
  const sent: unknown[] = [];
  const response = { memoryRecordSummaries: [], nextToken: "next" };
  const core = coreWithDataSend(async (command) => {
    sent.push(command);
    return response;
  });
  const input = {
    memoryId: "memory-123",
    namespace: "/customers/acme",
    memoryStrategyId: "strategy-123",
    maxResults: 25,
    nextToken: "current",
  };

  const result = await core.memory.listMemoryRecords(input, { region: "us-east-1" });

  expect(result).toBe(response);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(ListMemoryRecordsCommand);
  expect((sent[0] as ListMemoryRecordsCommand).input).toEqual(input);
});

test("getRuntime sends the abort signal to the control client", async () => {
  const sent: { command: unknown; options: unknown }[] = [];
  const core = new CoreClient({
    createControlClient: (config) =>
      ({
        config,
        send: async (command: unknown, options: unknown) => {
          sent.push({ command, options });
          return {};
        },
      }) as unknown as BedrockAgentCoreControlClient,
    createDataClient: fakeData,
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });
  const controller = new AbortController();

  await core.runtime.getRuntime("runtime-123", { region: "us-east-1" }, controller.signal);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(GetAgentRuntimeCommand);
  expect((sent[0]!.command as GetAgentRuntimeCommand).input).toEqual({
    agentRuntimeId: "runtime-123",
  });
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
});

test("invokeHarness sends an InvokeHarnessCommand on the data client with the abort signal", async () => {
  // A fake data client that records what send() receives and resolves a canned
  // response, so we can assert the harness sub-client's SDK translation.
  const sent: { command: unknown; options: unknown }[] = [];
  const configs: ClientConfig[] = [];
  const response = { stream: undefined };
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) => {
      configs.push(config);
      return {
        config,
        kind: "data",
        send: async (command: unknown, options: unknown) => {
          sent.push({ command, options });
          return response;
        },
      } as unknown as BedrockAgentCoreClient;
    },
    createIamClient: fakeIam,
    createLogsClient: fakeLogs,
    logger: createSilentLogger(),
  });

  const request = {
    harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/h-1",
    runtimeSessionId: "s".repeat(40),
    messages: [{ role: "user" as const, content: [{ text: "hi" }] }],
  };
  const controller = new AbortController();
  const result = await core.harness.invokeHarness(
    request,
    { region: "us-east-1", endpointUrl: "https://custom" },
    controller.signal,
  );

  expect(result).toBe(response);
  expect(configs).toEqual([{ region: "us-east-1", endpoint: "https://custom" }]);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(InvokeHarnessCommand);
  expect((sent[0]!.command as InvokeHarnessCommand).input).toEqual(request);
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
});

test("invokeHarness stream iteration rejects promptly when aborted mid-stream", async () => {
  // A stream that yields one event then hangs, like a live turn between
  // events; the SDK itself does not fail the iteration on abort at this point.
  const hangingStream: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      yield "first";
      await new Promise(() => {});
    },
  };
  const core = coreWithDataSend(async () => ({ stream: hangingStream }));

  const controller = new AbortController();
  const response = await core.harness.invokeHarness(
    { harnessArn: "arn", runtimeSessionId: "s".repeat(40), messages: [] },
    { region: "us-east-1" },
    controller.signal,
  );

  const iterator = response.stream![Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe("first");

  const pending = iterator.next();
  controller.abort();
  expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("invokeAgentRuntimeCommand sends the command on the data client with the abort signal", async () => {
  const sent: { command: unknown; options: unknown }[] = [];
  const core = coreWithDataSend(async (command, options) => {
    sent.push({ command, options });
    return { statusCode: 200, stream: undefined };
  });

  const request = {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/h-1",
    body: { command: "ls" },
  };
  const controller = new AbortController();
  await core.harness.invokeAgentRuntimeCommand(request, { region: "us-east-1" }, controller.signal);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(InvokeAgentRuntimeCommandCommand);
  expect((sent[0]!.command as InvokeAgentRuntimeCommandCommand).input).toEqual(request);
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
});

test("invokeRuntime maps all modeled IAM fields and response metadata", async () => {
  const sent: { command: unknown; options: unknown }[] = [];
  const body = (async function* () {
    yield Uint8Array.from([0, 1, 255]);
  })();
  const sdkResponse = {
    statusCode: 202,
    contentType: "application/octet-stream",
    runtimeSessionId: "runtime-session",
    mcpSessionId: "mcp-session",
    mcpProtocolVersion: "2025-06-18",
    traceId: "trace-id",
    traceParent: "trace-parent",
    traceState: "trace-state",
    baggage: "baggage",
    response: body,
  };
  const core = coreWithDataSend(async (command, options) => {
    sent.push({ command, options });
    return sdkResponse;
  });
  const request: RuntimeInvokeRequest = {
    runtimeId: "runtime-123",
    accountId: "123456789012",
    qualifier: "DEFAULT",
    payload: Uint8Array.from([123, 125]),
    contentType: "application/json",
    accept: "text/event-stream",
    runtimeSessionId: "runtime-session",
    runtimeUserId: "runtime-user",
    mcpSessionId: "mcp-session",
    mcpProtocolVersion: "2025-06-18",
    mcpMethod: "tools/call",
    mcpName: "weather",
    traceId: "trace-id",
    traceParent: "trace-parent",
    traceState: "trace-state",
    baggage: "tenant=retail",
  };
  const controller = new AbortController();

  const result = await core.runtime.invokeRuntime(
    request,
    { region: "us-west-2", endpointUrl: "https://custom" },
    controller.signal,
  );

  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(InvokeAgentRuntimeCommand);
  const { runtimeId, ...input } = request;
  expect((sent[0]!.command as InvokeAgentRuntimeCommand).input).toEqual({
    ...input,
    agentRuntimeArn: runtimeId,
  });
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
  const { response, ...metadata } = sdkResponse;
  expect(result).toEqual({
    ...metadata,
    body: response,
  });
});

test("invokeRuntime adds ordered application headers outside the modeled IAM input", async () => {
  let command: InvokeAgentRuntimeCommand | undefined;
  const core = coreWithDataSend(async (sent) => {
    command = sent as InvokeAgentRuntimeCommand;
    return { statusCode: 204 };
  });

  await core.runtime.invokeRuntime(
    {
      runtimeId: "runtime-123",
      accountId: "123456789012",
      qualifier: "DEFAULT",
      payload: new Uint8Array(),
      contentType: "application/json",
      applicationHeaders: [
        ["X-One", "1"],
        ["x-two", "2"],
      ],
    },
    { region: "us-east-1" },
  );

  expect(command).toBeInstanceOf(InvokeAgentRuntimeCommand);
  expect(command!.input).not.toHaveProperty("applicationHeaders");
  expect(await resolveRuntimeApplicationHeaders(command!)).toEqual([
    ["X-One", "1"],
    ["x-two", "2"],
  ]);
});

test("invokeRuntime aborts an established IAM response stream", async () => {
  const source = (async function* () {
    yield Buffer.from("partial");
    await new Promise(() => {});
  })();
  const core = coreWithDataSend(async () => ({
    statusCode: 200,
    contentType: "text/plain",
    response: source,
  }));
  const controller = new AbortController();
  const response = await core.runtime.invokeRuntime(
    {
      runtimeId: "runtime-123",
      accountId: "123456789012",
      qualifier: "DEFAULT",
      payload: new Uint8Array(),
      contentType: "application/json",
    },
    { region: "us-east-1" },
    controller.signal,
  );
  const iterator = response.body[Symbol.asyncIterator]();

  expect(await iterator.next()).toEqual({ done: false, value: Buffer.from("partial") });
  const pending = iterator.next();
  controller.abort();

  const result = await Promise.race([
    pending.then(
      () => "completed",
      (error: Error) => error.name,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 25)),
  ]);
  expect(result).toBe("AbortError");
});

test("IAM invoke preserves modeled AWS service errors", async () => {
  const failure = new ValidationException({
    message: "Runtime session ID must contain at least 33 characters",
    reason: "FieldValidationFailed",
    $metadata: {
      httpStatusCode: 400,
      requestId: "request-456",
    },
  });
  const core = coreWithDataSend(async () => {
    throw failure;
  });

  await expect(
    core.runtime.invokeRuntime(
      {
        runtimeId: "runtime-123",
        accountId: "123456789012",
        qualifier: "DEFAULT",
        payload: new TextEncoder().encode("{}"),
        contentType: "application/json",
      },
      { region: "us-east-1" },
    ),
  ).rejects.toBe(failure);
});

test("CUSTOM_JWT invoke uses the generated endpoint and exact fetch request", async () => {
  const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
  const controller = new AbortController();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(Uint8Array.from([1, 2]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "returned-runtime",
        "Mcp-Session-Id": "returned-mcp",
      },
    });
  };
  const core = customJwtCore(fetch);
  const payload = Uint8Array.from([123, 0, 125]);

  const result = await core.runtime.invokeRuntime(
    {
      runtimeId: "runtime/id",
      accountId: "123456789012",
      qualifier: "prod green",
      payload,
      contentType: "application/json",
      accept: "text/event-stream",
      runtimeSessionId: "runtime-session",
      runtimeUserId: "runtime-user",
      applicationHeaders: [["X-Tenant", "retail"]],
      bearerToken: "secret-token",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
      mcpMethod: "tools/call",
      mcpName: "weather",
      traceId: "trace-id",
      traceParent: "trace-parent",
      traceState: "trace-state",
      baggage: "tenant=retail",
    },
    { region: "us-west-2", endpointUrl: "https://runtime.test/base" },
    controller.signal,
  );

  expect(calls).toHaveLength(1);
  expect(String(calls[0]!.input)).toBe(
    "https://runtime.test/base/runtimes/runtime%2Fid/invocations?accountId=123456789012&qualifier=prod+green",
  );
  expect(calls[0]!.init).toMatchObject({
    method: "POST",
    redirect: "error",
    body: payload,
    signal: controller.signal,
  });
  expect(new Headers(calls[0]!.init!.headers)).toEqual(
    new Headers({
      Accept: "text/event-stream",
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "weather",
      "Mcp-Protocol-Version": "2025-06-18",
      "Mcp-Session-Id": "mcp-session",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "runtime-session",
      "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": "runtime-user",
      "X-Amzn-Trace-Id": "trace-id",
      "X-Tenant": "retail",
      baggage: "tenant=retail",
      traceparent: "trace-parent",
      tracestate: "trace-state",
    }),
  );
  expect(result.runtimeSessionId).toBe("returned-runtime");
  expect(result.mcpSessionId).toBe("returned-mcp");
  const resultBytes: Uint8Array[] = [];
  for await (const chunk of result.body) resultBytes.push(chunk);
  expect(Buffer.concat(resultBytes)).toEqual(Buffer.from([1, 2]));
});

test("CUSTOM_JWT invoke generates a Runtime session ID when omitted", async () => {
  let headers = new Headers();
  const core = customJwtCore(async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response(undefined, { status: 204 });
  });

  await core.runtime.invokeRuntime(
    {
      runtimeId: "runtime-123",
      accountId: "123456789012",
      qualifier: "DEFAULT",
      payload: new Uint8Array(),
      contentType: "application/json",
      bearerToken: "secret-token",
    },
    { region: "us-east-1" },
  );

  expect(headers.get("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("CUSTOM_JWT rejects non-HTTPS endpoints without calling fetch", async () => {
  let fetched = false;
  const core = customJwtCore(
    async () => {
      fetched = true;
      return new Response();
    },
    { endpoint: "http://runtime.test" },
  );

  await expect(
    core.runtime.invokeRuntime(
      {
        runtimeId: "runtime-123",
        accountId: "123456789012",
        qualifier: "DEFAULT",
        payload: new TextEncoder().encode("secret payload"),
        contentType: "application/json",
        bearerToken: "secret-token",
      },
      { region: "us-east-1" },
    ),
  ).rejects.toThrow("CUSTOM_JWT requires an HTTPS endpoint");
  expect(fetched).toBe(false);
});

test("CUSTOM_JWT modeled header failures do not expose their values", async () => {
  let fetched = false;
  const core = customJwtCore(async () => {
    fetched = true;
    return new Response();
  });

  await expect(
    core.runtime.invokeRuntime(
      {
        runtimeId: "runtime-123",
        accountId: "123456789012",
        qualifier: "DEFAULT",
        payload: new Uint8Array(),
        contentType: "application/json",
        bearerToken: "secret-token",
        traceParent: "secret-header\r\nvalue",
      },
      { region: "us-east-1" },
    ),
  ).rejects.toThrow(/^Invalid Runtime request header$/);
  expect(fetched).toBe(false);
});

test("CUSTOM_JWT non-2xx cancels without reading and exposes status only", async () => {
  const { logger, logs } = captureLogs();
  let cancelled = 0;
  let read = false;
  const response = {
    ok: false,
    status: 401,
    headers: new Headers(),
    body: {
      cancel: async () => {
        cancelled++;
      },
      async *[Symbol.asyncIterator]() {
        read = true;
        yield new TextEncoder().encode("secret response body");
      },
    },
  } as unknown as Response;
  const core = customJwtCore(async () => response, { logger });
  const request: RuntimeInvokeRequest = {
    runtimeId: "runtime-123",
    accountId: "123456789012",
    qualifier: "DEFAULT",
    payload: new TextEncoder().encode("secret payload"),
    contentType: "application/json",
    bearerToken: "secret-token",
    applicationHeaders: [["X-Secret", "secret-header-value"]],
  };

  await expect(core.runtime.invokeRuntime(request, { region: "us-east-1" })).rejects.toThrow(
    /^HTTP 401$/,
  );
  expect(cancelled).toBe(1);
  expect(read).toBe(false);
  expectSafeDebugLog(
    logs,
    "Runtime invocation returned a non-success response",
    {
      authMode: "CUSTOM_JWT",
      runtimeId: "runtime-123",
      qualifier: "DEFAULT",
      region: "us-east-1",
      httpStatusCode: 401,
    },
    ["secret response body", "secret payload", "secret-token", "secret-header-value"],
  );
});

test("CUSTOM_JWT transport failures do not expose arbitrary causes", async () => {
  const { logger, logs } = captureLogs();
  const core = customJwtCore(
    async () => {
      const error = new Error("failed with Bearer secret-token");
      error.name = "Bearer secret-token";
      throw error;
    },
    { logger },
  );

  await expect(
    core.runtime.invokeRuntime(
      {
        runtimeId: "runtime-123",
        accountId: "123456789012",
        qualifier: "DEFAULT",
        payload: new TextEncoder().encode("secret payload"),
        contentType: "application/json",
        bearerToken: "secret-token",
        applicationHeaders: [["X-Secret", "secret-header-value"]],
      },
      { region: "us-east-1" },
    ),
  ).rejects.toThrow(/^Runtime invocation failed$/);
  expectSafeDebugLog(
    logs,
    "Runtime invocation transport failed",
    {
      authMode: "CUSTOM_JWT",
      runtimeId: "runtime-123",
      qualifier: "DEFAULT",
      region: "us-east-1",
      errorName: "Error",
    },
    ["failed with Bearer secret-token", "secret payload", "secret-token", "secret-header-value"],
  );
});

test("invokeRuntime exposes an empty async iterable when the SDK omits the body", async () => {
  const core = coreWithDataSend(async () => ({
    statusCode: 204,
    contentType: "application/json",
  }));

  const response = await core.runtime.invokeRuntime(
    {
      runtimeId: "runtime-123",
      accountId: "123456789012",
      qualifier: "DEFAULT",
      payload: new Uint8Array(),
      contentType: "application/json",
    },
    { region: "us-east-1" },
  );

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  expect(chunks).toEqual([]);
});

test("invokeHarness returns the stream untouched when no abort signal is given", async () => {
  const stream = (async function* () {})();
  const core = coreWithDataSend(async () => ({ stream }));

  const response = await core.harness.invokeHarness(
    { harnessArn: "arn", runtimeSessionId: "s".repeat(40), messages: [] },
    { region: "us-east-1" },
  );
  expect(response.stream).toBe(stream);
});

test("toClientConfig maps region and omits endpoint when not overridden", () => {
  expect(toClientConfig({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
});

test("toClientConfig sets endpoint only when an override is provided", () => {
  expect(toClientConfig({ region: "us-east-1", endpointUrl: "https://custom" })).toEqual({
    region: "us-east-1",
    endpoint: "https://custom",
  });
});
