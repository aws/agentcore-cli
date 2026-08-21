import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { SilentCLIError, UserCancellationError } from "../../../errors";
import type { GatewayInvokeResponse } from "../types";
import { writeGatewayInvokeResponse } from "./response";

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function capture() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    bytes: () => Buffer.concat(chunks),
  };
}

function response(overrides: Partial<GatewayInvokeResponse> = {}): GatewayInvokeResponse {
  return {
    statusCode: 200,
    contentType: "application/json",
    body: body(Buffer.from("{}")),
    ...overrides,
  };
}

describe("Gateway invoke response output", () => {
  test("streams exact bytes and reports Gateway metadata", async () => {
    const stdout = capture();
    const stderr = capture();

    await writeGatewayInvokeResponse(
      response({
        statusCode: 206,
        contentType: "text/event-stream",
        runtimeSessionId: "runtime-session",
        mcpSessionId: "mcp-session",
        mcpProtocolVersion: "2025-06-18",
        requestId: "request-123",
        body: body(Buffer.from([0, 255]), Buffer.from([10, 1])),
      }),
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(stdout.bytes()).toEqual(Buffer.from([0, 255, 10, 1]));
    expect(stderr.bytes().toString()).toBe(
      "status=206 content-type=text/event-stream runtime-session-id=runtime-session " +
        "mcp-session-id=mcp-session mcp-protocol-version=2025-06-18 " +
        "request-id=request-123 complete=true bytes=4\n",
    );
  });

  test("JSON mode emits one metadata and body envelope", async () => {
    const stdout = capture();
    const stderr = capture();

    await writeGatewayInvokeResponse(
      response({
        mcpSessionId: "mcp-session",
        requestId: "request-123",
        body: body(Buffer.from('{"ok":true}')),
      }),
      { stdout: stdout.stream, stderr: stderr.stream, json: true },
    );

    expect(JSON.parse(stdout.bytes().toString())).toEqual({
      statusCode: 200,
      contentType: "application/json",
      mcpSessionId: "mcp-session",
      requestId: "request-123",
      bodyEncoding: "utf8",
      body: '{"ok":true}',
      complete: true,
    });
    expect(stderr.bytes()).toHaveLength(0);
  });

  test.each([204, 205])("allows HTTP %s without a content type on a TTY", async (statusCode) => {
    const stdout = capture();
    const stderr = capture();
    Object.defineProperty(stdout.stream, "isTTY", { value: true });

    await writeGatewayInvokeResponse(
      response({
        statusCode,
        contentType: "",
        body: body(),
      }),
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(stdout.bytes()).toHaveLength(0);
    expect(stderr.bytes().toString()).toContain(`status=${statusCode} content-type=-`);
    expect(stderr.bytes().toString()).toContain("complete=true bytes=0");
  });

  test("preserves partial output and reports a sanitized stream failure", async () => {
    const stdout = capture();
    const stderr = capture();
    const upstream = new Error("secret upstream response");

    const pending = writeGatewayInvokeResponse(
      response({
        body: (async function* () {
          yield Buffer.from("partial");
          throw upstream;
        })(),
      }),
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    await expect(pending).rejects.toBeInstanceOf(SilentCLIError);
    await expect(pending).rejects.toThrow("response stream failed");

    expect(stdout.bytes().toString()).toBe("partial");
    expect(stderr.bytes().toString()).toContain(
      "complete=false bytes=7 error=response-stream-failed",
    );
    expect(stderr.bytes().toString()).not.toContain(upstream.message);
  });

  test("preserves the shared cancellation reason after reporting an interruption", async () => {
    const controller = new AbortController();
    const cancellation = new UserCancellationError();
    const stdout = capture();
    const stderr = capture();
    const source = (async function* () {
      yield Buffer.from("partial");
      controller.abort(cancellation);
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    })();

    await expect(
      writeGatewayInvokeResponse(response({ body: source }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);
    expect(stdout.bytes().toString()).toBe("partial");
    expect(stderr.bytes().toString()).toContain("complete=false bytes=7 error=interrupted");
  });
});
