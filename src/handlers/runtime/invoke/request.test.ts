import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { SourceResolutionError } from "../../../io";
import {
  normalizeRuntimeInvokeRequest,
  parseRuntimeInvokeHeaders,
  resolveRuntimeInvokeSources,
  UsageError,
} from "./request";

const REGION = "us-west-2";
const RUNTIME_ID = "runtime-123";
const ACCOUNT_ID = "123456789012";
const ARN = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}`;

function detail(overrides: Partial<GetAgentRuntimeResponse> = {}): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: ARN,
    protocolConfiguration: { serverProtocol: "HTTP" },
    ...overrides,
  } as GetAgentRuntimeResponse;
}

function stdin(bytes: Uint8Array, onRead?: () => void): NodeJS.ReadStream {
  return Readable.from(
    (async function* () {
      onRead?.();
      yield bytes;
    })(),
  ) as NodeJS.ReadStream;
}

describe("resolveRuntimeInvokeSources", () => {
  test("resolves payload bytes and bearer-token text through one resolver", async () => {
    const bytes = Uint8Array.from([9, 0, 254]);
    const result = await resolveRuntimeInvokeSources(
      { payload: "-", bearerToken: "secret-€" },
      stdin(bytes),
    );

    expect(result.payload).toEqual(bytes);
    expect(result.bearerToken).toBe("secret-€");
  });

  test("rejects dual stdin before reading", async () => {
    let reads = 0;
    await expect(
      resolveRuntimeInvokeSources(
        { payload: "-", bearerToken: "-" },
        stdin(new Uint8Array(), () => reads++),
      ),
    ).rejects.toThrow("Payload and bearer token cannot both read from stdin");
    expect(reads).toBe(0);
  });

  test("classifies source-resolution failures as usage", async () => {
    const error = await resolveRuntimeInvokeSources({ payload: "-" }).catch((error) => error);

    expect(error).toBeInstanceOf(UsageError);
    expect(error).toMatchObject({
      message: "stdin is not available for '--payload'",
      exitCode: 2,
    });
    expect(error.cause).toBeInstanceOf(SourceResolutionError);
  });

  test("rejects a bearer token that is not valid UTF-8", async () => {
    const error = await resolveRuntimeInvokeSources(
      { payload: "{}", bearerToken: "-" },
      stdin(Uint8Array.from([0xff, 0x61])),
    ).catch((error) => error);

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe("'--bearer-token' must contain valid UTF-8");
    expect(error.cause).toBeInstanceOf(SourceResolutionError);
  });

  test("preserves abort errors", async () => {
    const input = new Readable({ read() {} }) as NodeJS.ReadStream;
    const controller = new AbortController();
    const resolving = resolveRuntimeInvokeSources({ payload: "-" }, input, controller.signal);
    controller.abort();

    try {
      await expect(
        Promise.race([
          resolving,
          Bun.sleep(100).then(() => {
            throw new Error("stdin read did not abort");
          }),
        ]),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      input.destroy();
      await resolving.catch(() => {});
    }
  });
});

describe("parseRuntimeInvokeHeaders", () => {
  test("brands validation failures as usage errors", () => {
    expect(() => parseRuntimeInvokeHeaders(["missing separator"])).toThrow(UsageError);
  });

  test.each([
    [
      "name",
      "Bad Name: secret-name-value",
      "Invalid HTTP header name: Bad Name (must use valid HTTP token characters)",
      "secret-name-value",
    ],
    [
      "value",
      "X-Test: secret-value ☃",
      "Invalid header value for X-Test: contains a character not allowed in HTTP headers",
      "secret-value ☃",
    ],
  ])(
    "explains an invalid header %s without exposing its value",
    (_case, header, message, secret) => {
      const error = (() => {
        try {
          parseRuntimeInvokeHeaders([header]);
        } catch (caught) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain(secret);
    },
  );

  test("does not impose client-only count or value-size limits", () => {
    const largeValue = "x".repeat(4097);
    const headers = [
      ...Array.from({ length: 20 }, (_, index) => `X-Test-${index}: value`),
      `X-Large: ${largeValue}`,
    ];

    const parsed = parseRuntimeInvokeHeaders(headers);

    expect(parsed).toHaveLength(21);
    expect(parsed.at(-1)).toEqual(["X-Large", largeValue]);
  });
});

describe("normalizeRuntimeInvokeRequest", () => {
  test.each([
    [
      "CUSTOM_JWT without a token",
      detail({ authorizerConfiguration: { customJWTAuthorizer: {} } as never }),
      {},
      "requires --bearer-token",
    ],
    ["IAM with a token", detail(), { bearerToken: "secret" }, "does not accept --bearer-token"],
    [
      "an unsupported authorizer",
      detail({ authorizerConfiguration: { $unknown: ["future", {}] } as never }),
      {},
      "unsupported authorizer",
    ],
    ["MCP options on HTTP", detail(), { mcpMethod: "tools/list" }, "only valid for MCP"],
  ])("rejects %s", (_name, runtime, overrides, message) => {
    expect(() =>
      normalizeRuntimeInvokeRequest(runtime, {
        runtimeId: RUNTIME_ID,
        payload: new Uint8Array(),
        ...overrides,
      }),
    ).toThrow(message);
  });

  test("rejects headers outside the Runtime allowlist", () => {
    expect(() =>
      normalizeRuntimeInvokeRequest(
        detail({ requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Test"] } }),
        {
          runtimeId: RUNTIME_ID,
          payload: new Uint8Array(),
          applicationHeaders: [["X-Not-Allowed", "value"]],
        },
      ),
    ).toThrow("not allowed");
  });

  test("defaults MCP requests to the required JSON and SSE response types", () => {
    const request = normalizeRuntimeInvokeRequest(
      detail({ protocolConfiguration: { serverProtocol: "MCP" } }),
      {
        runtimeId: RUNTIME_ID,
        payload: new Uint8Array(),
      },
    );

    expect(request.accept).toBe("application/json, text/event-stream");
  });

  test("maps every request field and ordered allowed headers once", () => {
    const request = normalizeRuntimeInvokeRequest(
      detail({
        authorizerConfiguration: { customJWTAuthorizer: {} } as never,
        protocolConfiguration: { serverProtocol: "MCP" },
        requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
      }),
      {
        runtimeId: RUNTIME_ID,
        qualifier: "prod",
        payload: Uint8Array.from([1, 2, 3]),
        contentType: "application/octet-stream",
        accept: "text/event-stream",
        runtimeSessionId: "runtime-session",
        runtimeUserId: "runtime-user",
        applicationHeaders: parseRuntimeInvokeHeaders([
          "X-Tenant: retail",
          "x-amzn-bedrock-agentcore-runtime-custom-mode: fast",
        ]),
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
    );

    expect(request).toEqual({
      runtimeId: RUNTIME_ID,
      accountId: ACCOUNT_ID,
      qualifier: "prod",
      payload: Uint8Array.from([1, 2, 3]),
      contentType: "application/octet-stream",
      accept: "text/event-stream",
      runtimeSessionId: "runtime-session",
      runtimeUserId: "runtime-user",
      applicationHeaders: [
        ["X-Tenant", "retail"],
        ["x-amzn-bedrock-agentcore-runtime-custom-mode", "fast"],
      ],
      bearerToken: "secret-token",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
      mcpMethod: "tools/call",
      mcpName: "weather",
      traceId: "trace-id",
      traceParent: "trace-parent",
      traceState: "trace-state",
      baggage: "tenant=retail",
    });
  });
});
