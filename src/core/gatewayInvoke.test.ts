import { describe, expect, test } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { GatewayInvokeRequest } from "../handlers/gateway/types";
import { createSilentLogger } from "../testing";
import { CoreClient } from "./index";
import type { CoreFetch } from "./types";

function request(overrides: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return {
    gatewayId: "gateway-123",
    url: "https://gateway.example.test/mcp",
    method: "POST",
    authorizerType: "NONE",
    payload: new TextEncoder().encode("{}"),
    contentType: "application/json",
    ...overrides,
  };
}

function coreWithFetch(
  fetch: CoreFetch,
  sign?: (request: {
    method: string;
    protocol: string;
    hostname: string;
    port?: number;
    path: string;
    query?: Record<string, string | string[] | null>;
    headers: Record<string, string>;
    body?: unknown;
  }) => Promise<{
    headers: Record<string, string>;
  }>,
): CoreClient {
  return new CoreClient({
    createControlClient: (config) =>
      ({ config, send: async () => ({}) }) as unknown as BedrockAgentCoreControlClient,
    createDataClient: (config) =>
      ({
        config: {
          ...config,
          signer: async () => ({
            sign:
              sign ?? (async (signedRequest: { headers: Record<string, string> }) => signedRequest),
          }),
        },
      }) as unknown as BedrockAgentCoreClient,
    createIamClient: (config) => ({ config }) as unknown as IAMClient,
    createLogsClient: (config) => ({ config }) as unknown as CloudWatchLogsClient,
    fetch,
    logger: createSilentLogger(),
  });
}

describe("Gateway invoke Core transport", () => {
  test.each(["CUSTOM_JWT", "AUTHENTICATE_ONLY"] as const)(
    "sends exact bytes and bearer authentication for %s",
    async (authorizerType) => {
      const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
      const payload = Uint8Array.from([0, 255, 1]);
      const core = coreWithFetch(async (input, init) => {
        calls.push({ input, init });
        return new Response(Buffer.from("ok"), {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Mcp-Session-Id": "returned-mcp",
            "Mcp-Protocol-Version": "2025-06-18",
            "X-Amzn-RequestId": "request-123",
          },
        });
      });
      const controller = new AbortController();

      const response = await core.gateway.invokeGateway(
        request({
          authorizerType,
          url: "https://gateway.example.test/target/invocations?trace=true",
          payload,
          bearerToken: "secret-token",
          accept: "text/event-stream",
          applicationHeaders: [["X-Tenant", "retail"]],
          runtimeSessionId: "runtime-session",
          mcpSessionId: "mcp-session",
          mcpProtocolVersion: "2025-06-18",
        }),
        { region: "us-west-2", endpointUrl: "https://control.example.test" },
        controller.signal,
      );

      expect(calls).toHaveLength(1);
      expect(String(calls[0]!.input)).toBe(
        "https://gateway.example.test/target/invocations?trace=true",
      );
      expect(calls[0]!.init).toMatchObject({
        method: "POST",
        redirect: "manual",
        body: payload,
        signal: controller.signal,
      });
      expect(new Headers(calls[0]!.init!.headers)).toEqual(
        new Headers({
          Accept: "text/event-stream",
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          "Mcp-Protocol-Version": "2025-06-18",
          "Mcp-Session-Id": "mcp-session",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "runtime-session",
          "X-Tenant": "retail",
        }),
      );
      expect(response).toMatchObject({
        statusCode: 200,
        contentType: "text/plain",
        mcpSessionId: "returned-mcp",
        mcpProtocolVersion: "2025-06-18",
        requestId: "request-123",
      });
    },
  );

  test("signs IAM requests with the data client's resolved signer", async () => {
    const fetchCalls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const signedRequests: unknown[] = [];
    const core = coreWithFetch(
      async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response(undefined, { status: 204 });
      },
      async (requestToSign) => {
        signedRequests.push(requestToSign);
        return {
          ...requestToSign,
          headers: {
            ...requestToSign.headers,
            authorization: "AWS4-HMAC-SHA256 signed",
            "x-amz-date": "20260810T000000Z",
          },
        };
      },
    );

    await core.gateway.invokeGateway(
      request({
        authorizerType: "AWS_IAM",
        url: "https://gateway.example.test:8443/path?tag=one&tag=two&space=a+b",
      }),
      { region: "us-east-1", endpointUrl: "https://control.example.test" },
    );

    expect(signedRequests).toEqual([
      {
        method: "POST",
        protocol: "https:",
        hostname: "gateway.example.test",
        port: 8443,
        path: "/path",
        query: { tag: ["one", "two"], space: "a b" },
        headers: {
          "content-type": "application/json",
          host: "gateway.example.test:8443",
        },
        body: new TextEncoder().encode("{}"),
      },
    ]);
    expect(new Headers(fetchCalls[0]!.init!.headers).get("authorization")).toBe(
      "AWS4-HMAC-SHA256 signed",
    );
  });

  test("sends NONE requests unsigned and supports GET without a body", async () => {
    let init: RequestInit | undefined;
    let signerCalled = false;
    const core = coreWithFetch(
      async (_input, requestInit) => {
        init = requestInit;
        return new Response(undefined, { status: 204 });
      },
      async (requestToSign) => {
        signerCalled = true;
        return requestToSign;
      },
    );

    await core.gateway.invokeGateway(
      request({
        method: "GET",
        authorizerType: "NONE",
        payload: undefined,
        contentType: undefined,
      }),
      { region: "us-east-1" },
    );

    expect(signerCalled).toBe(false);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init).not.toHaveProperty("body");
    expect(new Headers(init!.headers).has("authorization")).toBe(false);
  });

  test.each([
    [302, "redirect response"],
    [405, "Method Not Allowed"],
  ])("returns HTTP %d bodies without following or discarding them", async (status, content) => {
    let init: RequestInit | undefined;
    const core = coreWithFetch(async (_input, requestInit) => {
      init = requestInit;
      return new Response(content, {
        status,
        headers: { "Content-Type": "text/plain" },
      });
    });

    const response = await core.gateway.invokeGateway(
      request({
        authorizerType: "CUSTOM_JWT",
        bearerToken: "secret-token",
        applicationHeaders: [["X-Secret", "secret-header"]],
      }),
      { region: "us-east-1" },
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);

    expect(init?.redirect).toBe("manual");
    expect(response.statusCode).toBe(status);
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  test("sanitizes transport failures", async () => {
    const core = coreWithFetch(async () => {
      throw new Error("failed with Bearer secret-token");
    });

    await expect(
      core.gateway.invokeGateway(
        request({ authorizerType: "CUSTOM_JWT", bearerToken: "secret-token" }),
        { region: "us-east-1" },
      ),
    ).rejects.toThrow(/^Gateway invocation failed$/);
  });

  test("aborts an established response stream", async () => {
    const source = (async function* () {
      yield Buffer.from("partial");
      await new Promise(() => {});
    })();
    const core = coreWithFetch(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "text/plain" }),
        body: source,
      } as unknown as Response;
    });
    const controller = new AbortController();
    const response = await core.gateway.invokeGateway(
      request(),
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
});
