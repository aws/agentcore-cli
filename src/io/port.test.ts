import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { checkPort } from "./port";

function listen(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("checkPort rejects an occupied loopback port and accepts it after release", async () => {
  const server = await listen();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  const signal = new AbortController().signal;

  expect(await checkPort(address.port, signal)).toBe(false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await checkPort(address.port, signal)).toBe(true);
});

test("checkPort respects an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(checkPort(49152, controller.signal)).rejects.toHaveProperty("name", "AbortError");
});
