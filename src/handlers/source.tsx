import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { addAbortSignal } from "node:stream";

// readSource resolves a source-aware flag value to its raw bytes.
// Supports three forms:
//   - "file://path" reads the file at path
//   - "-" reads stdin to EOF
//   - anything else is returned as-is (inline value encoded as UTF-8)
export async function readSource(
  source: string,
  stdin?: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();

  if (source.startsWith("file://")) {
    const path = source.slice("file://".length);
    try {
      return await readFile(path, { signal });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      throw new TypeError(`unable to read source file: ${path}`);
    }
  }

  if (source === "-") {
    if (!stdin) {
      throw new TypeError("stdin is not available for this source");
    }
    const stream = signal ? addAbortSignal(signal, stdin) : stdin;
    return buffer(stream);
  }

  return new TextEncoder().encode(source);
}

// readSourceText resolves a source-aware flag value to a string.
export async function readSourceText(
  source: string,
  stdin?: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readSource(source, stdin, signal);
  return new TextDecoder().decode(bytes);
}
