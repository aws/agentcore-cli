import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import type { AppIO } from "../../../io";
import type { RuntimeInvokeRequest } from "../types";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  waitFor,
} from "../../../testing";
import { ExitCode, runWithExitCode } from "../../../runnable";
import { createRootHandler } from "../../index";

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
    io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
}

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

describe("runtime invoke", () => {
  test("resolves the Runtime, invokes its ID in the current account, and writes exact bytes", async () => {
    const { core, output } = await run([
      "runtime",
      "invoke",
      "--id",
      RUNTIME_ID,
      "--payload",
      '{"prompt":"hello"}',
    ]);

    expect(core.runtime.calls.map((call) => call.method)).toEqual(["getRuntime", "invokeRuntime"]);
    const lookup = core.runtime.calls[0]!;
    expect(lookup.args.slice(0, 2)).toEqual([RUNTIME_ID, { region: REGION }]);

    const invoke = core.runtime.calls[1]!;
    const request = invoke.args[0] as RuntimeInvokeRequest;
    expect(request).toEqual({
      runtimeId: RUNTIME_ID,
      accountId: ACCOUNT_ID,
      qualifier: "DEFAULT",
      payload: new TextEncoder().encode('{"prompt":"hello"}'),
      contentType: "application/json",
    });
    expect(invoke.args[1]).toEqual({ region: REGION });
    expect(lookup.args[2]).toBe(invoke.args[2]);
    expect(output.bytes()).toEqual(Buffer.from([0, 255, 10, 1]));
  });

  test("passes the public request flags through the shared normalizer", async () => {
    const { core } = await run(
      [
        "runtime",
        "invoke",
        "--id",
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

  test.each<[string, string[]]>([
    ["no request options", []],
    ["--content-type", ["--content-type", "text/plain"]],
    ["--header", ["--header", "X-Test: value"]],
    ["--output-file", ["--output-file", "response.bin"]],
    ["--json", ["--json"]],
  ])("requires a payload with %s before Core calls", async (_name, extraArgs) => {
    const core = new TestCoreClient();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, ["runtime", "invoke", "--id", RUNTIME_ID, ...extraArgs]),
    ).rejects.toThrow(/--payload/);
    expect(core.runtime.calls).toEqual([]);
  });

  test("rejects an empty --output-file before Core calls", async () => {
    const core = new TestCoreClient();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, [
        "runtime",
        "invoke",
        "--id",
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
    const core = new TestCoreClient();
    const output = captureIO();
    await expect(
      runCommand(core, output.io, [
        "runtime",
        "invoke",
        "--id",
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

  test("classifies --json with a streaming response as usage before reading the body", async () => {
    let iterations = 0;
    const core = new TestCoreClient();
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

    const code = await runWithExitCode(async () =>
      runCommand(core, output.io, [
        "runtime",
        "invoke",
        "--id",
        RUNTIME_ID,
        "--payload",
        "{}",
        "--json",
      ]),
    );

    expect(code).toBe(ExitCode.USAGE);
    expect(iterations).toBe(0);
    expect(output.bytes()).toHaveLength(0);
    const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[2] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  test("passes an explicitly empty payload as zero bytes", async () => {
    const { core } = await run(["runtime", "invoke", "--id", RUNTIME_ID, "--payload", ""]);

    const invoke = core.runtime.calls.find((call) => call.method === "invokeRuntime")!;
    expect((invoke.args[0] as RuntimeInvokeRequest).payload).toEqual(new Uint8Array());
  });

  test("SIGINT aborts an active headless invocation after preserving emitted bytes", async () => {
    const core = new TestCoreClient();
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
      "runtime",
      "invoke",
      "--id",
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
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(output.bytes().toString()).toBe("partial");
    } finally {
      await pending.catch(() => undefined);
    }
  });

  test("classifies an invalid Runtime ARN as usage before Core calls", async () => {
    const core = new TestCoreClient();
    const output = captureIO();

    const code = await runWithExitCode(async () =>
      runCommand(core, output.io, ["runtime", "invoke", "--id", RUNTIME_ARN, "--payload", "{}"]),
    );

    expect(code).toBe(ExitCode.USAGE);
    expect(core.runtime.calls).toEqual([]);
  });

  test("classifies required local validation as usage before Core calls", async () => {
    const core = new TestCoreClient();
    const output = captureIO();

    const code = await runWithExitCode(async () =>
      runCommand(core, output.io, ["runtime", "invoke", "--payload", "{}"]),
    );

    expect(code).toBe(ExitCode.USAGE);
    expect(core.runtime.calls).toEqual([]);
  });

  test("aborts an established request when a TTY refuses binary output", async () => {
    let iterations = 0;
    const core = new TestCoreClient();
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
      runCommand(core, output.io, ["runtime", "invoke", "--id", RUNTIME_ID, "--payload", "{}"]),
    ).rejects.toThrow("Binary or unknown response content requires --output-file or --json");

    const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(iterations).toBe(0);
  });

  test("rejects a resolved Runtime ARN without an account ID before invoke", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}::runtime/${RUNTIME_ID}`,
    } as GetAgentRuntimeResponse);
    const output = captureIO();

    await expect(
      runCommand(core, output.io, ["runtime", "invoke", "--id", RUNTIME_ID, "--payload", "{}"]),
    ).rejects.toThrow("Runtime returned an invalid ARN");
    expect(core.runtime.calls.map((call) => call.method)).toEqual(["getRuntime"]);
  });

  test.each<[string, ...string[]]>([
    ["malformed", "missing separator"],
    ["duplicate", "X-Test: one", "x-test: two"],
    ["reserved", "Authorization: secret"],
  ])("rejects %s headers as usage before Runtime Core calls", async (_name, ...headers) => {
    const core = new TestCoreClient();
    const output = captureIO();
    const args = ["runtime", "invoke", "--id", RUNTIME_ID, "--payload", "{}"];
    for (const header of headers) args.push("--header", header);

    const code = await runWithExitCode(async () => runCommand(core, output.io, args));

    expect(code).toBe(ExitCode.USAGE);
    expect(core.runtime.calls).toEqual([]);
  });

  test("reports an unreadable payload file as local usage before Runtime Core calls", async () => {
    const core = new TestCoreClient();
    const output = captureIO();
    const missing = join(tmpdir(), `missing-runtime-payload-${process.pid}`);

    await expect(
      runCommand(core, output.io, [
        "runtime",
        "invoke",
        "--id",
        RUNTIME_ID,
        "--payload",
        `file://${missing}`,
      ]),
    ).rejects.toMatchObject({
      name: "TypeError",
      message: `could not read '--payload' from file '${missing}'`,
      exitCode: ExitCode.USAGE,
    });
    expect(core.runtime.calls).toEqual([]);
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
        "runtime",
        "invoke",
        "--id",
        RUNTIME_ID,
        "--payload",
        "{}",
      ]),
    );
    const transportCode = await runWithExitCode(async () =>
      runCommand(transportCore, captureIO().io, [
        "runtime",
        "invoke",
        "--id",
        RUNTIME_ID,
        "--payload",
        "{}",
      ]),
    );
    const outputCode = await runWithExitCode(async () =>
      runCommand(outputCore, failingStdoutIO(), [
        "runtime",
        "invoke",
        "--id",
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
