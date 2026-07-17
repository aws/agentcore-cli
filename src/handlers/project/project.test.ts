import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../testing";

// End-to-end tests for the `project` command, driven through the real root
// handler and top-level route(). A TestCoreClient stands in for Core (the
// scaffold doesn't touch it, but createRootHandler requires one).

async function run(args: string[]): Promise<void> {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
}

describe("project create", () => {
  test("throws because it is not implemented yet", async () => {
    await expect(run(["create"])).rejects.toThrow(/not implemented/);
  });

  test("accepts a known --template value", async () => {
    await expect(run(["create", "--template", "placeholder"])).rejects.toThrow(/not implemented/);
  });

  test("rejects an unknown --template value", async () => {
    await expect(run(["create", "--template", "nonsense"])).rejects.toThrow();
  });
});
