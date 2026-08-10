import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import type { AppIO } from "../../../io";
import { ExitCode, runWithExitCode } from "../../../runnable";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  waitFor,
} from "../../../testing";
import { createRootHandler } from "../../index";
import type { GatewayInvokeRequest } from "../types";

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-123";
const GATEWAY_URL = "https://gateway-123.gateway.example.test/mcp";

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function captureIO(input?: Uint8Array) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  if (input !== undefined) stdin.end(input);
  return {
    io: {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    } satisfies AppIO,
    stdout: () => Buffer.concat(stdoutChunks),
    stderr: () => Buffer.concat(stderrChunks),
  };
}

async function runCommand(core: TestCoreClient, io: AppIO, args: string[]): Promise<void> {
  const root = createRootHandler(core, {
    io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
}

function configuredCore(gateway: Partial<GetGatewayResponse> = {}): TestCoreClient {
  const core = new TestCoreClient();
  core.gateway
    .setGetResponse({
      gatewayId: GATEWAY_ID,
      gatewayUrl: GATEWAY_URL,
      authorizerType: "NONE",
      ...gateway,
    } as GetGatewayResponse)
    .setInvokeResponse({
      statusCode: 200,
      contentType: "application/json",
      mcpSessionId: "returned-session",
      body: body(Buffer.from([0, 255]), Buffer.from([10, 1])),
    });
  return core;
}

describe("gateway invoke", () => {
  test("resolves the Gateway, invokes it, and streams exact response bytes", async () => {
    const core = configuredCore();
    const output = captureIO();

    await runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--payload",
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    ]);

    expect(core.gateway.calls.map((call) => call.method)).toEqual(["getGateway", "invokeGateway"]);
    const lookup = core.gateway.calls[0]!;
    const invoke = core.gateway.calls[1]!;
    expect(lookup.args.slice(0, 2)).toEqual([GATEWAY_ID, { region: REGION }]);
    expect(lookup.args[2]).toBe(invoke.args[2]);
    expect(invoke.args[1]).toEqual({ region: REGION });
    expect(invoke.args[0]).toEqual({
      gatewayId: GATEWAY_ID,
      url: GATEWAY_URL,
      method: "POST",
      authorizerType: "NONE",
      payload: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
      contentType: "application/json",
    });
    expect(output.stdout()).toEqual(Buffer.from([0, 255, 10, 1]));
    expect(output.stderr().toString()).toContain("mcp-session-id=returned-session");
  });

  test("passes method, root-relative path, headers, sessions, and endpoint options", async () => {
    const core = configuredCore({ authorizerType: "CUSTOM_JWT" });
    const output = captureIO();

    await runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--path",
      "target/invocations?trace=true",
      "--method",
      "DELETE",
      "--payload",
      "{}",
      "--content-type",
      "application/problem+json",
      "--accept",
      "text/event-stream",
      "--header",
      "X-Tenant: retail",
      "--bearer-token",
      "secret-token",
      "--session-id",
      "runtime-session",
      "--mcp-session-id",
      "mcp-session",
      "--mcp-protocol-version",
      "2025-06-18",
      "--endpoint-url",
      "https://control.example.test",
    ]);

    const request = core.gateway.calls.find((call) => call.method === "invokeGateway")!
      .args[0] as GatewayInvokeRequest;
    expect(request).toMatchObject({
      url: "https://gateway-123.gateway.example.test/target/invocations?trace=true",
      method: "DELETE",
      authorizerType: "CUSTOM_JWT",
      contentType: "application/problem+json",
      accept: "text/event-stream",
      applicationHeaders: [["X-Tenant", "retail"]],
      bearerToken: "secret-token",
      runtimeSessionId: "runtime-session",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
    });
    expect(core.gateway.calls[0]!.args[1]).toEqual({
      region: REGION,
      endpointUrl: "https://control.example.test",
    });
  });

  test("supports GET without a payload", async () => {
    const core = configuredCore({ gatewayUrl: "https://gateway.example.test" });
    const output = captureIO();

    await runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--method",
      "GET",
      "--path",
      "inference/v1/models",
    ]);

    expect(
      core.gateway.calls.find((call) => call.method === "invokeGateway")!.args[0],
    ).toMatchObject({
      method: "GET",
      url: "https://gateway.example.test/inference/v1/models",
    });
  });

  test("passes an explicitly empty payload as zero bytes", async () => {
    const core = configuredCore();
    const output = captureIO();

    await runCommand(core, output.io, ["gateway", "invoke", "--id", GATEWAY_ID, "--payload", ""]);

    const request = core.gateway.calls.find((call) => call.method === "invokeGateway")!
      .args[0] as GatewayInvokeRequest;
    expect(request.payload).toEqual(new Uint8Array());
  });

  test("resolves a bearer token from stdin through the command flow", async () => {
    const core = configuredCore({ authorizerType: "CUSTOM_JWT" });
    const output = captureIO(Buffer.from("secret-token"));

    await runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--payload",
      "{}",
      "--bearer-token",
      "-",
    ]);

    const request = core.gateway.calls.find((call) => call.method === "invokeGateway")!
      .args[0] as GatewayInvokeRequest;
    expect(request.bearerToken).toBe("secret-token");
  });

  test("buffers the response in JSON mode", async () => {
    const core = configuredCore();
    core.gateway.setInvokeResponse({
      statusCode: 200,
      contentType: "application/json",
      requestId: "request-123",
      body: body(Buffer.from('{"ok":true}')),
    });
    const output = captureIO();

    await runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--payload",
      "{}",
      "--json",
    ]);

    expect(JSON.parse(output.stdout().toString())).toMatchObject({
      statusCode: 200,
      requestId: "request-123",
      bodyEncoding: "utf8",
      body: '{"ok":true}',
      complete: true,
    });
    expect(output.stderr()).toHaveLength(0);
  });

  test.each([
    [["gateway", "invoke", "--payload", "{}"], /--id/],
    [["gateway", "invoke", "--id", GATEWAY_ID], /--payload/],
    [
      [
        "gateway",
        "invoke",
        "--id",
        GATEWAY_ID,
        "--payload",
        "{}",
        "--json",
        "--output-file",
        "response.bin",
      ],
      /--json cannot be used/,
    ],
    [
      ["gateway", "invoke", "--id", GATEWAY_ID, "--payload", "{}", "--request-type", "mcp"],
      /unknown option '--request-type'/,
    ],
  ] as const)("rejects invalid input before invocation", async (args, message) => {
    const core = configuredCore();
    const output = captureIO();
    await expect(runCommand(core, output.io, [...args])).rejects.toThrow(message);
    expect(core.gateway.calls.some((call) => call.method === "invokeGateway")).toBe(false);
  });

  test("classifies a missing ID as usage", async () => {
    const core = configuredCore();
    const output = captureIO();

    const code = await runWithExitCode(async () =>
      runCommand(core, output.io, ["gateway", "invoke", "--payload", "{}"]),
    );

    expect(code).toBe(ExitCode.USAGE);
    expect(core.gateway.calls).toEqual([]);
  });

  test("SIGINT aborts lookup and invocation through the same signal", async () => {
    const core = configuredCore();
    const output = captureIO();
    core.gateway.invokeGateway = async (request, options, signal) => {
      core.gateway.calls.push({ method: "invokeGateway", args: [request, options, signal] });
      return new Promise<never>((_, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("transport aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const pending = runCommand(core, output.io, [
      "gateway",
      "invoke",
      "--id",
      GATEWAY_ID,
      "--payload",
      "{}",
    ]);

    try {
      await waitFor(() => core.gateway.calls.some((call) => call.method === "invokeGateway"));
      process.emit("SIGINT", "SIGINT");

      await expect(pending).rejects.toMatchObject({ name: "AbortError", reported: false });
      const lookupSignal = core.gateway.calls[0]!.args[2] as AbortSignal;
      const invokeSignal = core.gateway.calls[1]!.args[2] as AbortSignal;
      expect(lookupSignal).toBe(invokeSignal);
      expect(invokeSignal.aborted).toBe(true);
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("registers a headless invoke leaf without a request-type flag", () => {
    const core = configuredCore();
    const output = captureIO();
    const root = createRootHandler(core, {
      io: output.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const gateway = root.children().find((child) => child.name() === "gateway");
    const invoke = gateway?.children().find((child) => child.name() === "invoke");

    expect(invoke).toBeDefined();
    expect(invoke?.flags().map((registered) => registered.name)).not.toContain("request-type");
  });
});
