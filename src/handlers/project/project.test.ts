import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

async function run(args: string[]): Promise<void> {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
}

describe.each(["add", "remove", "dev", "deploy", "status", "build"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

describe("project create", () => {
  test("throws because it is not implemented yet", async () => {
    await expect(run(["create"])).rejects.toThrow(/not implemented/);
  });

  test("accepts a known --template value", async () => {
    await expect(run(["create", "--template", "barebones"])).rejects.toThrow(/not implemented/);
  });

  test("rejects an unknown --template value", async () => {
    await expect(run(["create", "--template", "nonsense"])).rejects.toThrow();
  });
});
