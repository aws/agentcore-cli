import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { findAvailablePort } from "./port";

function occupy(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(() => server.close()));
  });
}

describe("findAvailablePort", () => {
  test("returns the requested port when free", async () => {
    const port = await findAvailablePort(42_800);
    expect(port).toBe(42_800);
  });

  test("walks up past an occupied port", async () => {
    const release = await occupy(42_810);
    try {
      expect(await findAvailablePort(42_810)).toBe(42_811);
    } finally {
      release();
    }
  });
});
