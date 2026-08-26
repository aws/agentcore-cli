import type { HttpResponse } from "../../../io/httpServer";

const encoder = new TextEncoder();

export function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function apiError(status: number, error: string): HttpResponse {
  return json(status, { success: false, error });
}

export function parseJsonBody(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString());
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {}
  return undefined;
}

export function parseTimeParam(
  url: URL,
  name: string,
): { value: number | undefined; error?: HttpResponse } {
  const raw = url.searchParams.get(name);
  if (raw === null) return { value: undefined };
  const value = Number(raw);
  if (Number.isNaN(value)) {
    return {
      value: undefined,
      error: apiError(400, `${name} must be a number (epoch milliseconds)`),
    };
  }
  return { value };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sse(body: AsyncIterable<Uint8Array>, sessionId?: string): HttpResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(sessionId !== undefined && { "x-session-id": sessionId }),
    },
    body,
  };
}

export function sseEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function* iterateBody(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* lines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string, void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    yield* parts;
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** SSE framing: strip one optional space after `data:`, join multiple `data:` lines with newlines, end the event on a blank line, ignore non-data lines. */
export async function* sseData(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string, void> {
  let data: string[] = [];
  for await (const raw of lines(stream)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (data.length > 0) {
        yield data.join("\n");
        data = [];
      }
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length > 0) yield data.join("\n");
}
