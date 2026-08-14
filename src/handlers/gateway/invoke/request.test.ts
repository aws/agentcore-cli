import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  normalizeGatewayInvokeRequest,
  parseGatewayInvokeHeaders,
  resolveGatewayInvokeSources,
} from "./request";

const GATEWAY_ID = "gateway-123";

function stdin(bytes?: Uint8Array): NodeJS.ReadStream {
  const stream = new PassThrough();
  if (bytes !== undefined) stream.end(bytes);
  return stream as unknown as NodeJS.ReadStream;
}

function detail(overrides: Partial<GetGatewayResponse> = {}): GetGatewayResponse {
  return {
    gatewayUrl: "https://gateway-123.gateway.example.test/mcp",
    authorizerType: "NONE",
    ...overrides,
  } as GetGatewayResponse;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: GATEWAY_ID,
    payload: new TextEncoder().encode("{}"),
    ...overrides,
  };
}

describe("Gateway invoke sources", () => {
  test("resolves payload bytes and bearer-token text through one resolver", async () => {
    const payload = Uint8Array.from([0, 255, 10]);

    const result = await resolveGatewayInvokeSources(
      { payload: "-", bearerToken: "secret-token" },
      stdin(payload),
    );

    expect(result.payload).toEqual(payload);
    expect(result.bearerToken).toBe("secret-token");
  });

  test("preserves an explicitly empty inline payload", async () => {
    const result = await resolveGatewayInvokeSources({ payload: "" }, stdin());
    expect(result.payload).toEqual(new Uint8Array());
  });

  test("rejects payload and bearer token both reading stdin before consuming it", async () => {
    await expect(
      resolveGatewayInvokeSources({ payload: "-", bearerToken: "-" }, stdin(Buffer.from("value"))),
    ).rejects.toThrow("cannot both read from stdin");
  });

  test("rejects a bearer token that is not valid UTF-8", async () => {
    await expect(
      resolveGatewayInvokeSources(
        { payload: "{}", bearerToken: "-" },
        stdin(Uint8Array.from([0xff])),
      ),
    ).rejects.toThrow("must contain valid UTF-8");
  });
});

describe("Gateway invoke headers", () => {
  test("parses ordered header values containing additional colons", () => {
    expect(parseGatewayInvokeHeaders(["X-One: 1", "X-Url: https://example.test/a:b"])).toEqual([
      ["X-One", "1"],
      ["X-Url", "https://example.test/a:b"],
    ]);
  });

  test.each([
    [["not-a-header"], "Name: value"],
    [["Bad Header: value"], "Invalid HTTP header name"],
    [["X-One: 1", "x-one: 2"], "Duplicate header"],
    [["Authorization: secret"], "reserved"],
    [["Mcp-Session-Id: session"], "reserved"],
    [["X-Amz-Date: date"], "reserved"],
  ])("rejects invalid header input %j", (headers, message) => {
    expect(() => parseGatewayInvokeHeaders(headers)).toThrow(message);
  });
});

describe("normalizeGatewayInvokeRequest", () => {
  test("uses the exact Gateway URL and defaults POST JSON requests", () => {
    expect(normalizeGatewayInvokeRequest(detail(), input())).toEqual({
      gatewayId: GATEWAY_ID,
      url: "https://gateway-123.gateway.example.test/mcp",
      method: "POST",
      authorizerType: "NONE",
      payload: new TextEncoder().encode("{}"),
      contentType: "application/json",
    });
  });

  test("replaces the returned path from the Gateway origin and preserves query values", () => {
    const request = normalizeGatewayInvokeRequest(
      detail(),
      input({ path: "/inference/v1/messages?stream=true&tag=one&tag=two" }),
    );

    expect(request.url).toBe(
      "https://gateway-123.gateway.example.test/inference/v1/messages?stream=true&tag=one&tag=two",
    );
  });

  test("supports GET without a payload and no implicit content type", () => {
    expect(
      normalizeGatewayInvokeRequest(
        detail({ gatewayUrl: "https://gateway.example.test" }),
        input({ method: "GET", path: "inference/v1/models", payload: undefined }),
      ),
    ).toEqual({
      gatewayId: GATEWAY_ID,
      url: "https://gateway.example.test/inference/v1/models",
      method: "GET",
      authorizerType: "NONE",
    });
  });

  test("maps every optional request field", () => {
    const request = normalizeGatewayInvokeRequest(
      detail({
        authorizerType: "CUSTOM_JWT",
        gatewayUrl: "https://gateway.example.test",
      }),
      input({
        path: "target/invocations",
        method: "DELETE",
        contentType: "application/problem+json",
        accept: "text/event-stream",
        applicationHeaders: [["X-Tenant", "retail"]],
        bearerToken: "secret",
        runtimeSessionId: "runtime-session",
        mcpSessionId: "mcp-session",
        mcpProtocolVersion: "2025-06-18",
      }),
    );

    expect(request).toMatchObject({
      method: "DELETE",
      authorizerType: "CUSTOM_JWT",
      contentType: "application/problem+json",
      accept: "text/event-stream",
      applicationHeaders: [["X-Tenant", "retail"]],
      bearerToken: "secret",
      runtimeSessionId: "runtime-session",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
    });
  });

  test.each([
    ["missing URL", detail({ gatewayUrl: undefined }), input(), "returned no invocation URL"],
    ["invalid URL", detail({ gatewayUrl: "not a URL" }), input(), "invalid invocation URL"],
    [
      "insecure URL",
      detail({ gatewayUrl: "http://gateway.example.test" }),
      input(),
      "requires an HTTPS URL",
    ],
    ["absolute path", detail(), input({ path: "https://evil.example" }), "must be relative"],
    ["network path", detail(), input({ path: "//evil.example/a" }), "must be relative"],
    ["fragment", detail(), input({ path: "target/path#fragment" }), "stay within"],
    ["dot segment", detail(), input({ path: "target/../secret" }), "cannot contain"],
    ["missing POST payload", detail(), input({ payload: undefined }), "--payload"],
    ["GET payload", detail(), input({ method: "GET" }), "do not accept --payload"],
    [
      "unsupported authorizer",
      detail({ authorizerType: undefined }),
      input(),
      "unsupported authorizer",
    ],
  ])("rejects %s", (_name, gateway, requestInput, message) => {
    expect(() => normalizeGatewayInvokeRequest(gateway, requestInput)).toThrow(message);
  });

  test.each(["CUSTOM_JWT"] as const)("requires a bearer token for %s", (authorizerType) => {
    expect(() => normalizeGatewayInvokeRequest(detail({ authorizerType }), input())).toThrow(
      "requires --bearer-token",
    );
  });

  test.each(["AUTHENTICATE_ONLY", "AWS_IAM", "NONE"] as const)(
    "rejects a bearer token for %s",
    (authorizerType) => {
      expect(() =>
        normalizeGatewayInvokeRequest(detail({ authorizerType }), input({ bearerToken: "secret" })),
      ).toThrow("does not accept --bearer-token");
    },
  );
});
