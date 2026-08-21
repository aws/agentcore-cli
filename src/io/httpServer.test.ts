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

  test("handler errors become 500s without crashing the server", async () => {
    handle = await startHttpServer(() => {
      throw new Error("boom");
    });

    const response = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(response.status).toBe(500);

    const again = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(again.status).toBe(500);
  });

  test("oversized bodies get a 413 response, not a connection reset", async () => {
    handle = await startHttpServer(() => ({ status: 200 }));

    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/traces`, {
      method: "POST",
      body: Buffer.alloc(51 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });

  test("binds the given host", async () => {
    handle = await startHttpServer(() => ({ status: 200 }), { host: "0.0.0.0" });
    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
  });

  test("a client that disconnects mid-response does not take down the server", async () => {
    handle = await startHttpServer(async () => {
      await Bun.sleep(50);
      return { status: 200, body: "late" };
    });

    const controller = new AbortController();
    const aborted = fetch(`http://127.0.0.1:${handle.port}/`, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow();
    await Bun.sleep(80);

    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
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
