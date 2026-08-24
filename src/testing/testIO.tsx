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
