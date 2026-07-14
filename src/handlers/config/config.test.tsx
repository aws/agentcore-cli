import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../index";
import { TestCoreClient, testExecutionPolicy, testIO } from "../../testing";

// End-to-end tests for the `config` command, driven through the real root
// handler and top-level route(). A TestCoreClient stands in for Core (config
// doesn't touch it, but createRootHandler requires one); an in-memory io
// captures the output.

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), io.io);
  await root.route(["node", "agentcore", "config", ...args], testExecutionPolicy());
  return io.stdout();
}

describe("config", () => {
  test("prints the key and value it was given", async () => {
    expect(await run(["telemetry.enabled", "true"])).toBe(
      "updating config key=telemetry.enabled, value=true",
    );
  });

  test("value is undefined when only a key is passed", async () => {
    expect(await run(["telemetry.enabled"])).toBe(
      "updating config key=telemetry.enabled, value=undefined",
    );
  });

  test("both key and value are undefined when none are passed", async () => {
    expect(await run([])).toBe("updating config key=undefined, value=undefined");
  });
});
