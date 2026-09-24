import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import type { AppIO } from "../../../io";
import type { RuntimeInvokeRequest } from "../../runtime/types";
import {
  IMPERATIVE_GLOBAL_CONFIG,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  StreamController,
  testIO,
  tick,
  waitFor,
} from "../../../testing";
import { runWithExitCode } from "../../../runnable";
import { ExitCode, UserCancellationError } from "../../../errors";
import { createRootHandler } from "../../index";
import * as tui from "../../../tui";
import { RuntimeInvokeLaunchContextKey } from "../../runtime/invoke/launchContext";

const REGION = "us-west-2";
const RUNTIME_ID = "runtime-123";
const ACCOUNT_ID = "123456789012";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}`;

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function captureIO(input?: Uint8Array): { io: AppIO; bytes: () => Buffer } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  if (input) stdin.end(input);
  return {
    io: {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    bytes: () => Buffer.concat(chunks),
  };
}

function failingStdoutIO(): AppIO {
  const { io } = captureIO();
  return {
    ...io,
    stdout: new Writable({
      write(_chunk, _encoding, callback) {
        callback(new TypeError("stdout transport failed"));
      },
    }) as unknown as NodeJS.WriteStream,
  };
}

async function runCommand(core: TestCoreClient, io: AppIO, args: string[]): Promise<void> {
  const root = createRootHandler(core, {
    globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({
      initialConfigData: IMPERATIVE_GLOBAL_CONFIG,
    }),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
}

function runtimeCore(): TestCoreClient {
  const core = new TestCoreClient();
  core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
  return core;
}

const methods = (core: TestCoreClient) => core.runtime.calls.map(({ method }) => method);

async function run(
  args: string[],
  { getResponse = { agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse } = {},
) {
  const core = new TestCoreClient();
  core.runtime.setGetResponse(getResponse);
  core.runtime.setInvokeResponse({
    statusCode: 200,
    contentType: "application/json",
    body: body(Uint8Array.from([0, 255]), Uint8Array.from([10, 1])),
  });
  const output = captureIO();

  await runCommand(core, output.io, args);
  return { core, output };
}

describe("invoke --runtime", () => {
  test.each(["payload", "bearer-token"] as const)(
    "reads TTY %s before starting progress",
    async (input) => {
      const core = runtimeCore();
      const stream = new StreamController<Uint8Array>();
      core.runtime
        .setGetResponse({
          agentRuntimeArn: RUNTIME_ARN,
          ...(input === "bearer-token" && { authorizerConfiguration: { customJWTAuthorizer: {} } }),
        } as GetAgentRuntimeResponse)
        .setInvokeResponse({ statusCode: 200, contentType: "text/plain", body: stream });
      const io = testIO({ isTTY: true });
      const stdin = io.io.stdin as unknown as PassThrough;
      const pending = runCommand(core, io.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        input === "payload" ? "-" : "{}",
        ...(input === "bearer-token" ? ["--bearer-token", "-"] : []),
      ]);
      try {
        await waitFor(() => stdin.listenerCount("readable") > 0);
        stdin.write(input === "payload" ? "{}" : "test-token");
        await tick(120);
        expect(io.stderr()).toBe("");
        expect(methods(core)).toEqual(["getRuntime"]);
        stdin.end();
        await waitFor(() => io.stderr().includes("Invoking runtime..."));
      } finally {
        stdin.end();
        stream.end();
        await pending;
      }
    },
  );

  test.each([false, true])(
    "hands progress to streamed output and respects JSON mode (json=%s)",
    async (json) => {
      const core = runtimeCore();
      const stream = new StreamController<Uint8Array>();
      core.runtime
        .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
        .setInvokeResponse({ statusCode: 200, contentType: "text/plain", body: stream });
      const io = testIO({ isTTY: true });
      const pending = runCommand(core, io.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
        ...(json ? ["--json"] : []),
      ]);
      try {
        await waitFor(() => core.runtime.calls.some(({ method }) => method === "invokeRuntime"));
        if (json) expect(io.stderr()).toBe("");
        else await waitFor(() => io.stderr().includes("Invoking runtime..."));
        stream.emit(Buffer.from("first"));
        if (json) expect(io.stdout()).toBe("");
        else await waitFor(() => io.stdout() === "first");
        const afterFirstChunk = io.stderr();
        await tick(120);
        expect(io.stderr()).toBe(afterFirstChunk);
      } finally {
        stream.emit(Buffer.from("second"));
        stream.end();
        await pending;
      }
      expect(json ? JSON.parse(io.stdout()).body : io.stdout()).toBe("firstsecond");
    },
  );

  test("resolves the Runtime, invokes its ID in the current account, and writes exact bytes", async () => {
    const { core, output } = await run([
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      '{"prompt":"hello"}',
    ]);

    expect(core.runtime.calls.map((call) => call.method)).toEqual([
      "getRuntime",
      "getRuntime",
      "invokeRuntime",
    ]);
    const lookup = core.runtime.calls[1]!;
    expect(lookup.args.slice(0, 2)).toEqual([RUNTIME_ID, { region: REGION }]);

    const invoke = core.runtime.calls[2]!;
    const request = invoke.args[0] as RuntimeInvokeRequest;
    expect(request).toEqual({
      runtimeId: RUNTIME_ID,
      accountId: ACCOUNT_ID,
      qualifier: "DEFAULT",
      payload: new TextEncoder().encode('{"prompt":"hello"}'),
      contentType: "application/json",
      runtimeUserId: "default",
      accept: "text/event-stream",
    });
    expect(invoke.args[1]).toEqual({ region: REGION });
    expect(lookup.args[2]).toBe(invoke.args[2]);
    expect(output.bytes()).toEqual(Buffer.from([0, 255, 10, 1]));
  });

  test("passes the public request flags through the shared normalizer", async () => {
    const { core } = await run(
      [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
        "--qualifier",
        "prod",
        "--content-type",
        "text/plain",
        "--session-id",
        "runtime-session",
        "--header",
        "X-Tenant: retail",
        "--mcp-method",
        "tools/call",
        "--bearer-token",
        "secret-token",
      ],
      {
        getResponse: {
          agentRuntimeArn: RUNTIME_ARN,
          authorizerConfiguration: { customJWTAuthorizer: {} },
          protocolConfiguration: { serverProtocol: "MCP" },
          requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
        } as GetAgentRuntimeResponse,
      },
    );

    const request = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(request).toMatchObject({
      qualifier: "prod",
      contentType: "text/plain",
      runtimeSessionId: "runtime-session",
      applicationHeaders: [["X-Tenant", "retail"]],
      mcpMethod: "tools/call",
      bearerToken: "secret-token",
    });
  });

  test.each([
    ["--content-type", "text/plain"],
    ["--output-file", "response.bin"],
  ])("rejects request option %s without a payload before invoking", async (flagName, value) => {
    const core = runtimeCore();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID, flagName, value]),
    ).rejects.toThrow(/--payload/);
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test("rejects an empty --output-file before Core calls", async () => {
    const core = runtimeCore();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
        "--output-file",
        "",
      ]),
    ).rejects.toThrow("requires a nonempty path");
    expect(core.runtime.calls).toEqual([]);
  });

  test("rejects --json with --output-file before Core calls", async () => {
    const core = runtimeCore();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
        "--json",
        "--output-file",
        "response.bin",
      ]),
    ).rejects.toThrow("--json cannot be used with --output-file");
    expect(core.runtime.calls).toEqual([]);
  });

  test("buffers a streaming response when --json is requested", async () => {
    let iterations = 0;
    const core = runtimeCore();
    const output = captureIO();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/event-stream",
        body: (async function* () {
          iterations++;
          yield Buffer.from("data: ready\n\n");
        })(),
      });

    await runCommand(core, output.io, [
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      "{}",
      "--json",
    ]);

    expect(iterations).toBe(1);
    expect(JSON.parse(output.bytes().toString())).toMatchObject({
      statusCode: 200,
      contentType: "text/event-stream",
      bodyEncoding: "utf8",
      body: "data: ready\n\n",
      complete: true,
    });
  });

  test("passes an explicitly empty payload as zero bytes", async () => {
    const { core } = await run(["invoke", "--runtime", RUNTIME_ID, "--payload", ""]);

    const invoke = core.runtime.calls.find((call) => call.method === "invokeRuntime")!;
    expect((invoke.args[0] as RuntimeInvokeRequest).payload).toEqual(new Uint8Array());
  });

  test("SIGINT cancels payload stdin resolution with the typed reason", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const initialListeners = process.listenerCount("SIGINT");
    const pending = runCommand(core, output.io, [
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      "-",
    ]);

    try {
      await waitFor(() => process.listenerCount("SIGINT") > initialListeners);
      process.emit("SIGINT", "SIGINT");

      await expect(pending).rejects.toBeInstanceOf(UserCancellationError);
      expect(methods(core)).toEqual(["getRuntime"]);
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("SIGINT replaces a raw Runtime lookup abort with the typed reason", async () => {
    const core = runtimeCore();
    const output = captureIO();
    core.runtime.getRuntime = async (id, options, signal) => {
      core.runtime.calls.push({ method: "getRuntime", args: [id, options, signal] });
      if (!signal) return { agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse;
      return new Promise<never>((_, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("lookup aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const pending = runCommand(core, output.io, [
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      "{}",
    ]);

    try {
      await waitFor(() => core.runtime.calls.length === 2);
      process.emit("SIGINT", "SIGINT");

      const signal = core.runtime.calls[1]!.args[2] as AbortSignal;
      expect(signal.reason).toBeInstanceOf(UserCancellationError);
      await expect(pending).rejects.toBe(signal.reason);
      expect(methods(core)).toEqual(["getRuntime", "getRuntime"]);
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("SIGINT aborts an active headless invocation after preserving emitted bytes", async () => {
    const core = runtimeCore();
    const output = captureIO();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request, options, signal) => {
      core.runtime.calls.push({ method: "invokeRuntime", args: [request, options, signal] });
      return {
        statusCode: 200,
        contentType: "text/event-stream",
        body: (async function* () {
          yield Buffer.from("partial");
          await new Promise<void>((_, reject) => {
            const abort = () =>
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        })(),
      };
    };
    const pending = runCommand(core, output.io, [
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      "{}",
    ]);

    try {
      await waitFor(() => output.bytes().toString() === "partial");
      const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!.args[2] as
        AbortSignal | undefined;
      expect(signal).toBeDefined();

      process.emit("SIGINT", "SIGINT");

      expect(signal!.aborted).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(UserCancellationError);
      expect(output.bytes().toString()).toBe("partial");
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("replaces a raw Core abort with the typed SIGINT reason", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const rawAbort = Object.assign(new Error("transport aborted"), { name: "AbortError" });
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request, options, signal) => {
      core.runtime.calls.push({ method: "invokeRuntime", args: [request, options, signal] });
      return new Promise<never>((_, reject) => {
        const abort = () => reject(rawAbort);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const pending = runCommand(core, output.io, [
      "invoke",
      "--runtime",
      RUNTIME_ID,
      "--payload",
      "{}",
    ]);

    try {
      await waitFor(() => core.runtime.calls.some((call) => call.method === "invokeRuntime"));
      process.emit("SIGINT", "SIGINT");

      const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
        .args[2] as AbortSignal;
      expect(signal.reason).toBeInstanceOf(UserCancellationError);
      await expect(pending).rejects.toBe(signal.reason);
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("aborts an established request when a TTY refuses binary output", async () => {
    let iterations = 0;
    const core = runtimeCore();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/octet-stream",
        body: (async function* () {
          iterations++;
          yield Buffer.from([0, 255]);
        })(),
      });
    const output = captureIO();
    Object.defineProperty(output.io.stdout, "isTTY", { value: true });

    await expect(
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID, "--payload", "{}"]),
    ).rejects.toThrow("Binary or unknown response content requires --output-file or --json");

    const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(iterations).toBe(0);
  });

  test("rejects a resolved Runtime ARN without an account ID before invoke", async () => {
    const core = runtimeCore();
    core.runtime.setGetResponse({
      agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}::runtime/${RUNTIME_ID}`,
    } as GetAgentRuntimeResponse);
    const output = captureIO();

    await expect(
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID, "--payload", "{}"]),
    ).rejects.toThrow("Runtime returned an invalid ARN");
    expect(methods(core)).toEqual(["getRuntime", "getRuntime"]);
  });

  test("classifies the TUI requirement as usage at the handler boundary", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const code = await runWithExitCode(async () =>
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID]),
    );

    expect(code).toBe(ExitCode.USAGE);
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test("preserves unexpected TUI rendering failures", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const failure = new TypeError("render failed");
    const render = spyOn(tui, "renderTuiAt").mockRejectedValue(failure);

    try {
      await expect(runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID])).rejects.toBe(
        failure,
      );
      expect(methods(core)).toEqual(["getRuntime"]);
    } finally {
      render.mockRestore();
    }
  });

  test("handler deep-links id-only and qualified invokes with encoded path segments", async () => {
    const core = runtimeCore();
    core.runtime.setGetResponse({
      agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/runtime/blue one`,
    } as GetAgentRuntimeResponse);
    const output = captureIO();
    const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);

    try {
      await runCommand(core, output.io, ["invoke", "--runtime", "runtime/blue one"]);
      await runCommand(core, output.io, [
        "invoke",
        "--runtime",
        "runtime/blue one",
        "--session-id",
        "session/one two",
      ]);
      await runCommand(core, output.io, [
        "invoke",
        "--runtime",
        "runtime/blue one",
        "--qualifier",
        "prod/green one",
      ]);
      await runCommand(core, output.io, [
        "invoke",
        "--runtime",
        "runtime/blue one",
        "--qualifier",
        "prod/green one",
        "--session-id",
        "session/one two",
      ]);

      expect(render.mock.calls.map(([path]) => path)).toEqual([
        "/agentcore/invoke/runtime/runtime%2Fblue%20one",
        "/agentcore/invoke/runtime/runtime%2Fblue%20one",
        "/agentcore/invoke/runtime/runtime%2Fblue%20one/prod%2Fgreen%20one",
        "/agentcore/invoke/runtime/runtime%2Fblue%20one/prod%2Fgreen%20one",
      ]);
      expect(render.mock.calls[1]![1].value(RuntimeInvokeLaunchContextKey)).toMatchObject({
        runtimeId: "runtime/blue one",
        runtimeSessionId: "session/one two",
      });
      expect(render.mock.calls[3]![1].value(RuntimeInvokeLaunchContextKey)).toMatchObject({
        runtimeId: "runtime/blue one",
        runtimeSessionId: "session/one two",
      });
    } finally {
      render.mockRestore();
    }
  });

  test("passes launch identity, authentication, and headers to the TUI without a payload", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);

    try {
      await runCommand(core, output.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--user-id",
        "user-123",
        "--header",
        "X-Tenant: retail",
        "--bearer-token",
        "secret-token",
      ]);

      expect(render).toHaveBeenCalledTimes(1);
      expect(render.mock.calls[0]![1].value(RuntimeInvokeLaunchContextKey)).toEqual({
        runtimeId: RUNTIME_ID,
        runtimeSessionId: undefined,
        runtimeUserId: "user-123",
        applicationHeaders: [["X-Tenant", "retail"]],
        bearerToken: "secret-token",
      });
      expect(methods(core)).toEqual(["getRuntime"]);
    } finally {
      render.mockRestore();
    }
  });

  test("rejects a stdin bearer token when launching the TUI", async () => {
    const core = runtimeCore();
    const output = captureIO();

    await expect(
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID, "--bearer-token", "-"]),
    ).rejects.toThrow("stdin bearer tokens are not available");
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test("handler keeps JSON mode without a payload as a usage error", async () => {
    const core = runtimeCore();
    const output = captureIO();

    await expect(
      runCommand(core, output.io, ["invoke", "--runtime", RUNTIME_ID, "--json"]),
    ).rejects.toThrow(/--payload/);
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test.each<[string, ...string[]]>([
    ["malformed", "missing separator"],
    ["duplicate", "X-Test: one", "x-test: two"],
    ["reserved", "Authorization: secret"],
  ])("rejects %s headers as input failures before invoking", async (_name, ...headers) => {
    const core = runtimeCore();
    const output = captureIO();
    const args = ["invoke", "--runtime", RUNTIME_ID, "--payload", "{}"];
    for (const header of headers) args.push("--header", header);

    const code = await runWithExitCode(async () => runCommand(core, output.io, args));

    expect(code).toBe(ExitCode.USAGE);
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test("reports an unreadable payload file as an input failure before invoking", async () => {
    const core = runtimeCore();
    const output = captureIO();
    const missing = join(tmpdir(), `missing-runtime-payload-${process.pid}`);

    await expect(
      runCommand(core, output.io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        `file://${missing}`,
      ]),
    ).rejects.toMatchObject({
      name: "InputValidationError",
      message: `could not read '--payload' from file '${missing}'`,
      exitCode: ExitCode.USAGE,
    });
    expect(methods(core)).toEqual(["getRuntime"]);
  });

  test("keeps Core, transport, and output TypeErrors as failures", async () => {
    const lookupCore = new TestCoreClient();
    lookupCore.runtime.setError(new TypeError("lookup failed"));
    const transportCore = new TestCoreClient();
    transportCore.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
    } as GetAgentRuntimeResponse);
    transportCore.runtime.invokeRuntime = async () => {
      throw new TypeError("transport failed");
    };
    const outputCore = new TestCoreClient();
    outputCore.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: body(Buffer.from("response")),
      });

    const lookupCode = await runWithExitCode(async () =>
      runCommand(lookupCore, captureIO().io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
      ]),
    );
    const transportCode = await runWithExitCode(async () =>
      runCommand(transportCore, captureIO().io, [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
      ]),
    );
    const outputCode = await runWithExitCode(async () =>
      runCommand(outputCore, failingStdoutIO(), [
        "invoke",
        "--runtime",
        RUNTIME_ID,
        "--payload",
        "{}",
      ]),
    );

    expect([lookupCode, transportCode, outputCode]).toEqual([
      ExitCode.FAILURE,
      ExitCode.FAILURE,
      ExitCode.FAILURE,
    ]);
  });
});
