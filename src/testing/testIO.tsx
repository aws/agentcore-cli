import { PassThrough } from "node:stream";
import type { AppIO } from "../io";

// TestIO bundles an in-memory AppIO with accessors to read back what was written
// to each stream. Pass `io` to createRootHandler({ io }) to capture a command's
// output without touching the process streams or console.*, then assert on
// `stdout()` / `stderr()`.
export interface TestIO {
  // io is the AppIO to inject into createRootHandler.
  io: AppIO;
  // stdout / stderr return everything written to that stream so far, with any
  // trailing newline trimmed so callers can assert on clean values.
  stdout(): string;
  stderr(): string;
}

export interface TestIOOptions {
  isTTY?: boolean;
  // stdin pre-fills the input stream with piped content, then ends it. Use this
  // to test handlers that read a secret or prompt from stdin ('-').
  stdin?: string;
}

// collect wraps a PassThrough, accumulating everything written to it as a string.
function collect(): { stream: NodeJS.WriteStream; read: () => string } {
  const stream = new PassThrough();
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
  });
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => buffer.replace(/\n+$/, ""),
  };
}

// testIO builds a fresh in-memory TestIO for a single test. stdin is an idle
// PassThrough (no input) so screens that read input simply see nothing.
export function testIO({ isTTY = false, stdin: stdinContent }: TestIOOptions = {}): TestIO {
  const out = collect();
  const err = collect();
  const stdinStream = new PassThrough();
  if (stdinContent !== undefined) stdinStream.end(stdinContent);
  const stdin = stdinStream as unknown as NodeJS.ReadStream;

  for (const stream of [stdin, out.stream, err.stream]) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY });
  }

  return {
    io: { stdin, stdout: out.stream, stderr: err.stream },
    stdout: out.read,
    stderr: err.read,
  };
}

// TtyInput is the writable stdin of a TTY TestIO: tests push raw key sequences
// into it to drive a mounted TUI.
export interface TtyInput extends NodeJS.ReadStream {
  write(chunk: string): boolean;
}

// ttyTestIO builds a TestIO that Ink will accept as a real terminal: isTTY on
// every stream, the no-op setRawMode/ref/unref that Ink calls when it takes over
// stdin, and a fixed window size (Ink needs columns/rows to lay frames out).
// Use it for tests that mount the TUI through the production path
// (renderTui/renderTuiAt) rather than through ink-testing-library.
export function ttyTestIO(columns = 100, rows = 40): { streams: TestIO; stdin: TtyInput } {
  const streams = testIO({ isTTY: true });
  const stdin = streams.io.stdin as TtyInput;
  stdin.setRawMode = function () {
    return this;
  };
  stdin.ref = function () {
    return this;
  };
  stdin.unref = function () {
    return this;
  };
  Object.defineProperties(streams.io.stdout, {
    columns: { configurable: true, value: columns },
    rows: { configurable: true, value: rows },
  });
  return { streams, stdin };
}
