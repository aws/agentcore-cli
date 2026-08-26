// Uses node:http rather than Bun.serve because the npm bundle targets Node, where Bun APIs are absent.
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
  signal: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer | AsyncIterable<Uint8Array>;
}

export type HttpRequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

// Binds 127.0.0.1 by default. A wider bind like 0.0.0.0 is only for reaching the server from a container.
export async function startHttpServer(
  handler: HttpRequestHandler,
  options: { port?: number; host?: string; signal?: AbortSignal } = {},
): Promise<HttpServerHandle> {
  const server = createServer((request, response) => {
    // Swallow rejections so a client that disconnects mid-response cannot take down the dev command.
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
  // Under Bun's node:http a mid-stream disconnect is not surfaced, so this teardown is a no-op there and leaks a local dev fetch until it finishes.
  const controller = new AbortController();
  response.on("close", () => controller.abort());

  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    // Answer before closing. Destroying the socket first surfaces as a connection reset, which many clients silently retry.
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
      signal: controller.signal,
    });
    response.writeHead(result.status, result.headers);
    if (isAsyncIterable(result.body)) {
      await stream(result.body, response, controller.signal);
    } else {
      response.end(result.body);
    }
  } catch {
    // Once any byte is written, writeHead throws, so only send the 500 before the response has started.
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "internal error" }));
  }
}

function isAsyncIterable(body: HttpResponse["body"]): body is AsyncIterable<Uint8Array> {
  return typeof body === "object" && body !== null && Symbol.asyncIterator in body;
}

export async function stream(
  body: AsyncIterable<Uint8Array>,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  for await (const chunk of body) {
    if (signal.aborted) break;
    if (!response.write(chunk)) await drain(response, signal);
  }
  if (!signal.aborted) response.end();
}

function drain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    response.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
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
