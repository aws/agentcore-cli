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
  body?: string | Buffer;
}

export type HttpRequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export interface HttpServerHandle {
  /** The port the server is listening on. */
  port: number;
  /** Stops accepting connections and closes active ones. Idempotent. */
  close(): Promise<void>;
}

/**
 * Starts an HTTP server for local dev tooling. Binds `host` (default 127.0.0.1)
 * on the given port (0 lets the OS assign one). Handler errors become plain 500s;
 * oversized bodies become 413s. Aborting the signal closes the server. A wider
 * bind such as 0.0.0.0 is only for reaching the server from a container.
 */
export async function startHttpServer(
  handler: HttpRequestHandler,
  options: { port?: number; host?: string; signal?: AbortSignal } = {},
): Promise<HttpServerHandle> {
  const server = createServer((request, response) => {
    // A dropped connection mid-response can reject here; swallow it so a client
    // that disconnects can never take down the whole dev command.
    void respond(handler, request, response).catch(() => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
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
    // Answer before closing: destroying the socket first surfaces as a connection
    // reset, which many clients treat as transient and silently retry.
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    response.writeHead(status, { Connection: "close" }).end(() => request.destroy());
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
    response.end(result.body);
  } catch {
    // Once any byte is written, writeHead throws, so only send the 500 when the
    // response has not started; otherwise just close what is already open.
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "internal error" }));
  }
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.pause();
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
