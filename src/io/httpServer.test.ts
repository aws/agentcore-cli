import { afterEach, describe, expect, test } from "bun:test";
import { type HttpServerHandle, startHttpServer } from "./httpServer";

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("startHttpServer", () => {
  test("serves requests on an OS-assigned loopback port", async () => {
    handle = await startHttpServer((request) => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: request.method,
        url: request.url,
        body: request.body.toString(),
      }),
    }));

    expect(handle.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/traces`, {
      method: "POST",
      body: "ping",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: "POST", url: "/v1/traces", body: "ping" });
  });

  test("an AsyncIterable body streams chunks to the client", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("data: one\n\n");
      await Bun.sleep(5);
      yield new TextEncoder().encode("data: two\n\n");
    }
    handle = await startHttpServer(() => ({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: chunks(),
    }));

    const response = await fetch(`http://127.0.0.1:${handle.port}/events`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("a mid-stream failure cuts the connection instead of ending cleanly", async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("stream died");
    }
    handle = await startHttpServer(() => ({ status: 200, body: broken() }));

    expect(fetch(`http://127.0.0.1:${handle.port}/`).then((r) => r.text())).rejects.toThrow();
  });

  test("handler errors become 500s without crashing the server", async () => {
    handle = await startHttpServer(() => {
      throw new Error("boom");
    });

    const response = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(response.status).toBe(500);

    const again = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(again.status).toBe(500);
  });

  test("aborting the signal closes the server", async () => {
    const controller = new AbortController();
    const server = await startHttpServer(() => ({ status: 200 }), { signal: controller.signal });

    controller.abort();
    await Bun.sleep(20);
    expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
  });

  test("close is idempotent", async () => {
    const server = await startHttpServer(() => ({ status: 200 }));
    await server.close();
    await server.close();
  });

  test("listen failure rejects instead of hanging", async () => {
    handle = await startHttpServer(() => ({ status: 200 }));
    expect(startHttpServer(() => ({ status: 200 }), { port: handle.port })).rejects.toThrow();
  });
});
