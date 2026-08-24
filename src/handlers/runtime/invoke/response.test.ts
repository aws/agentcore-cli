import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { SilentCLIError, UserCancellationError } from "../../../errors";
import { waitFor } from "../../../testing";
import type { RuntimeInvokeResponse } from "../types";
import { writeRuntimeInvokeResponse } from "./response";

const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function failingBody(error: Error): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from("partial");
    throw error;
  })();
}

function response(overrides: Partial<RuntimeInvokeResponse> = {}): RuntimeInvokeResponse {
  return {
    statusCode: 200,
    contentType: "text/plain",
    body: body(Buffer.from("ok")),
    ...overrides,
  };
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

describe("Runtime invoke response output", () => {
  test("streams exact chunks in raw mode, reports metadata, and leaves stdout open", async () => {
    const stdout = capture();
    const stderr = capture();
    const result = response({
      statusCode: 206,
      contentType: "text/plain",
      runtimeSessionId: "runtime-session",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
      traceId: "trace-id",
      traceParent: "trace-parent",
      traceState: "trace-state",
      baggage: "tenant=retail",
      body: body(Buffer.from([0, 255]), Buffer.from([10, 1])),
    });

    await writeRuntimeInvokeResponse(result, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.bytes()).toEqual(Buffer.from([0, 255, 10, 1]));
    expect(stderr.bytes().toString()).toBe(
      "status=206 content-type=text/plain runtime-session-id=runtime-session " +
        "mcp-session-id=mcp-session mcp-protocol-version=2025-06-18 trace-id=trace-id " +
        "trace-parent=trace-parent trace-state=trace-state baggage=tenant=retail " +
        "complete=true bytes=4\n",
    );
    expect(stdout.stream.writableEnded).toBe(false);
    stdout.stream.write(Buffer.from([127]));
    expect(stdout.bytes()).toEqual(Buffer.from([0, 255, 10, 1, 127]));
  });

  test("streams plain text before the Runtime response completes", async () => {
    const stdout = capture();
    const stderr = capture();
    const firstConsumed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pending = writeRuntimeInvokeResponse(
      response({
        body: (async function* () {
          yield Buffer.from("first");
          firstConsumed.resolve();
          await finish.promise;
          yield Buffer.from("second");
        })(),
      }),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    await firstConsumed.promise;
    const bytesBeforeCompletion = stdout.bytes();
    finish.resolve();
    await pending;

    expect(bytesBeforeCompletion.toString()).toBe("first");
    expect(stdout.bytes().toString()).toBe("firstsecond");
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/plain runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=true bytes=11\n",
    );
  });

  test("sanitizes metadata output failures", async () => {
    const stdout = capture();
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("secret metadata sink failure"));
      },
    }) as unknown as NodeJS.WriteStream;

    const pending = writeRuntimeInvokeResponse(response(), {
      stdout: stdout.stream,
      stderr,
    });

    await expect(pending).rejects.toBeInstanceOf(SilentCLIError);
    await expect(pending).rejects.toThrow("response stream failed");
  });

  test("streams exact bytes to a file and leaves stdout empty", async () => {
    const file = join(tmpdir(), `runtime-invoke-output-${process.pid}-${files.length}`);
    files.push(file);
    const stdout = capture();
    const stderr = capture();
    const mutable = Buffer.alloc(2);

    await writeRuntimeInvokeResponse(
      response({
        body: (async function* () {
          mutable.set([0, 255]);
          yield mutable;
          mutable.set([10, 1]);
          yield mutable;
        })(),
      }),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        outputFile: file,
      },
    );

    expect(Buffer.from(await Bun.file(file).bytes())).toEqual(Buffer.from([0, 255, 10, 1]));
    expect(stdout.bytes()).toHaveLength(0);
  });

  test("streams non-streaming content directly to a file", async () => {
    const file = join(tmpdir(), `runtime-invoke-output-${process.pid}-${files.length}`);
    files.push(file);
    const stdout = capture();
    const stderr = capture();
    const firstWritten = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pending = writeRuntimeInvokeResponse(
      response({
        body: (async function* () {
          yield Buffer.from("first");
          firstWritten.resolve();
          await finish.promise;
          yield Buffer.from("second");
        })(),
      }),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        outputFile: file,
      },
    );

    await firstWritten.promise;
    let bytesBeforeCompletion: Buffer;
    try {
      await waitFor(async () => {
        try {
          return (await Bun.file(file).text()) === "first";
        } catch {
          return false;
        }
      });
      bytesBeforeCompletion = Buffer.from(await Bun.file(file).bytes());
    } finally {
      finish.resolve();
      await pending;
    }

    expect(bytesBeforeCompletion.toString()).toBe("first");
    expect(Buffer.from(await Bun.file(file).bytes()).toString()).toBe("firstsecond");
    expect(stdout.bytes()).toHaveLength(0);
  });

  test("JSON mode emits one textual response envelope and no stderr", async () => {
    const stdout = capture();
    const stderr = capture();
    const mutable = Buffer.alloc(16);
    const result = response({
      statusCode: 201,
      contentType: "application/problem+json",
      runtimeSessionId: "runtime-session",
      body: (async function* () {
        const first = Buffer.from('{"message":');
        const second = Buffer.from('"created"}');
        mutable.set(first);
        yield mutable.subarray(0, first.length);
        mutable.set(second);
        yield mutable.subarray(0, second.length);
      })(),
    });

    await writeRuntimeInvokeResponse(result, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      json: true,
    });

    expect(stdout.bytes().toString()).toBe(
      JSON.stringify({
        statusCode: 201,
        contentType: "application/problem+json",
        runtimeSessionId: "runtime-session",
        bodyEncoding: "utf8",
        body: '{"message":"created"}',
        complete: true,
      }),
    );
    expect(stderr.bytes()).toHaveLength(0);
  });

  test("preserves partial stdout and reports one static incomplete summary", async () => {
    const stdout = capture();
    const stderr = capture();
    const error = new Error("secret upstream detail");

    await expect(
      writeRuntimeInvokeResponse(
        response({ contentType: "text/event-stream", body: failingBody(error) }),
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      ),
    ).rejects.toThrow("response stream failed");

    expect(stdout.bytes().toString()).toBe("partial");
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/event-stream runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=7 error=response-stream-failed\n",
    );
    expect(stderr.bytes().toString()).not.toContain(error.message);
  });

  test("writes an interruption summary after the output signal is aborted", async () => {
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
      writeRuntimeInvokeResponse(response({ contentType: "text/event-stream", body: source }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);
    expect(stdout.bytes().toString()).toBe("partial");
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/event-stream runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=7 error=interrupted\n",
    );
  });

  test("JSON cancellation emits no partial envelope and preserves the typed reason", async () => {
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
      writeRuntimeInvokeResponse(response({ body: source }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
        json: true,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);
    expect(stdout.bytes()).toHaveLength(0);
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/plain runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=7 error=interrupted\n",
    );
  });

  test("preserves partial raw output regardless of response media type", async () => {
    const stdout = capture();
    const stderr = capture();
    const error = new Error("secret upstream detail");

    await expect(
      writeRuntimeInvokeResponse(response({ body: failingBody(error) }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow("response stream failed");

    expect(stdout.bytes().toString()).toBe("partial");
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/plain runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=7 error=response-stream-failed\n",
    );
    expect(stderr.bytes().toString()).not.toContain(error.message);
  });

  test("JSON mode emits no partial envelope and reports a static error when buffering fails", async () => {
    const stdout = capture();
    const stderr = capture();
    const error = new Error("secret upstream detail");

    await expect(
      writeRuntimeInvokeResponse(response({ body: failingBody(error) }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
        json: true,
      }),
    ).rejects.toThrow("response stream failed");

    expect(stdout.bytes()).toHaveLength(0);
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=text/plain runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=7 error=response-stream-failed\n",
    );
    expect(stderr.bytes().toString()).not.toContain(error.message);
  });

  test("JSON mode buffers a streaming representation into one atomic envelope", async () => {
    const stdout = capture();
    const stderr = capture();
    const firstConsumed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const source = (async function* () {
      yield Buffer.from('data: {"part":1}\n\n');
      firstConsumed.resolve();
      await finish.promise;
      yield Buffer.from('data: {"part":2}\n\n');
    })();

    const pending = writeRuntimeInvokeResponse(
      response({ contentType: "text/event-stream", body: source }),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        json: true,
      },
    );

    await firstConsumed.promise;
    const bytesBeforeCompletion = stdout.bytes();
    finish.resolve();
    await pending;

    expect(bytesBeforeCompletion).toHaveLength(0);
    expect(JSON.parse(stdout.bytes().toString())).toMatchObject({
      contentType: "text/event-stream",
      bodyEncoding: "utf8",
      body: 'data: {"part":1}\n\ndata: {"part":2}\n\n',
      complete: true,
    });
    expect(stderr.bytes()).toHaveLength(0);
  });

  test.each([
    ["binary content", "application/octet-stream", Buffer.from([0, 255, 1])],
    ["invalid UTF-8 text", "text/plain", Buffer.from([0xc3, 0x28])],
  ])("JSON mode base64-encodes %s", async (_name, contentType, bytes) => {
    const stdout = capture();
    const stderr = capture();

    await writeRuntimeInvokeResponse(response({ contentType, body: body(bytes) }), {
      stdout: stdout.stream,
      stderr: stderr.stream,
      json: true,
    });

    expect(JSON.parse(stdout.bytes().toString())).toMatchObject({
      contentType,
      bodyEncoding: "base64",
      body: bytes.toString("base64"),
      complete: true,
    });
    expect(stderr.bytes()).toHaveLength(0);
  });

  test("JSON mode base64-encodes binary content on a TTY", async () => {
    const stdout = capture();
    const stderr = capture();
    Object.defineProperty(stdout.stream, "isTTY", { value: true });
    const bytes = Buffer.from([0, 255, 1]);

    await writeRuntimeInvokeResponse(
      response({ contentType: "application/octet-stream", body: body(bytes) }),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        json: true,
      },
    );

    expect(JSON.parse(stdout.bytes().toString())).toMatchObject({
      contentType: "application/octet-stream",
      bodyEncoding: "base64",
      body: bytes.toString("base64"),
      complete: true,
    });
    expect(stderr.bytes()).toHaveLength(0);
  });

  test("refuses unknown content on a TTY before iterating the body", async () => {
    let iterations = 0;
    const stdout = capture();
    const stderr = capture();
    Object.defineProperty(stdout.stream, "isTTY", { value: true });
    const source = (async function* () {
      iterations++;
      yield Buffer.from([0]);
    })();

    await expect(
      writeRuntimeInvokeResponse(response({ contentType: "", body: source }), {
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow("Binary or unknown response content requires --output-file or --json");
    expect(iterations).toBe(0);
    expect(stdout.bytes()).toHaveLength(0);
    expect(stderr.bytes().toString()).toBe(
      "status=200 content-type=- runtime-session-id=- mcp-session-id=- " +
        "mcp-protocol-version=- trace-id=- trace-parent=- trace-state=- baggage=- " +
        "complete=false bytes=0\n",
    );
  });
});
