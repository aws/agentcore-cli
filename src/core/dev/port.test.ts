import { describe, expect, test } from "bun:test";
import type { PortChecker } from "../../io";
import { PortInUseError, resolveDevPort } from "./port";

const signal = new AbortController().signal;

describe("resolveDevPort", () => {
  test.each([
    ["HTTP", 8080],
    ["AGUI", 8080],
    ["MCP", 8000],
    ["A2A", 9000],
  ] as const)("uses the %s default", async (protocol, port) => {
    expect(await resolveDevPort(protocol, undefined, async () => true, signal)).toEqual({
      port,
      requestedPort: port,
    });
  });

  test("walks up from occupied defaults", async () => {
    const checked: number[] = [];
    const check: PortChecker = async (port) => {
      checked.push(port);
      return port === 8002;
    };

    expect(await resolveDevPort("MCP", undefined, check, signal)).toEqual({
      port: 8002,
      requestedPort: 8000,
    });
    expect(checked).toEqual([8000, 8001, 8002]);
  });

  test("accepts a free explicit port and rejects an occupied one", async () => {
    expect(await resolveDevPort("A2A", 4567, async () => true, signal)).toEqual({
      port: 4567,
      requestedPort: 4567,
    });
    const occupied = resolveDevPort("A2A", 4567, async () => false, signal);
    await expect(occupied).rejects.toBeInstanceOf(PortInUseError);
    await expect(occupied).rejects.toThrow("lsof -i :4567");
  });

  test("bounds the default search", async () => {
    await expect(resolveDevPort("HTTP", undefined, async () => false, signal)).rejects.toThrow(
      "No free port found in range 8080-8179",
    );
  });
});
