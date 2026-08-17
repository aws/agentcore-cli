// Uses node:http rather than Bun.serve because the npm bundle targets Node,
// where Bun APIs are absent (same constraint as exec.ts).
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

/** Cap request bodies so a runaway local client cannot exhaust memory. */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

export interface HttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  /** An AsyncIterable body streams chunks to the client as they are produced (e.g. SSE). */
  body?: string | Buffer | AsyncIterable<Uint8Array>;
}

export type HttpRequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export interface HttpServerHandle {
  /** The port the server is listening on. */
  port: number;
  /** Stops accepting connections and closes active ones. Idempotent. */
  close(): Promise<void>;
}

/**
 * Starts a loopback-only HTTP server for local dev tooling. Binds 127.0.0.1 on
 * the given port (0 lets the OS assign one). Handler errors become plain 500s;
 * oversized bodies become 413s. Aborting the signal closes the server.
 */
export async function startHttpServer(
  handler: HttpRequestHandler,
  options: { port?: number; signal?: AbortSignal } = {},
): Promise<HttpServerHandle> {
  const server = createServer((request, response) => {
    void respond(handler, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const close = () => closeServer(server);
  options.signal?.addEventListener("abort", () => void close(), { once: true });

  return { port, close };
}

async function respond(
  handler: HttpRequestHandler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    response.writeHead(status).end();
    return;
  }

  try {
    const result = await handler({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
      body,
    });
    response.writeHead(result.status, result.headers);
    if (
      result.body === undefined ||
      typeof result.body === "string" ||
      Buffer.isBuffer(result.body)
    ) {
      response.end(result.body);
      return;
    }
    await streamBody(result.body, response);
  } catch {
    if (response.headersSent) {
      // Mid-stream failure: the status line is gone, so cut the connection to
      // signal an incomplete response instead of ending it as if successful.
      response.destroy();
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "internal error" }));
  }
}

async function streamBody(
  body: AsyncIterable<Uint8Array>,
  response: ServerResponse,
): Promise<void> {
  for await (const chunk of body) {
    if (response.destroyed) return;
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => response.once("drain", resolve));
    }
  }
  response.end();
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
