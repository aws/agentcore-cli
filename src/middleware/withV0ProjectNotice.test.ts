import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHandler, Router, type Context } from "../router";
import { inTempDirectory, testIO } from "../testing";
import { V0ProjectNoticeStateKey } from "../handlers/project/context";
import { V0_PROJECT_MIGRATION_MESSAGE } from "../handlers/project/v0Notice";
import { withV0ProjectNotice } from "./withV0ProjectNotice";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function writeProject(version: number): Promise<void> {
  const { path, cleanup } = await inTempDirectory("agentcore-v0-notice-");
  cleanups.push(cleanup);
  await mkdir(join(path, "agentcore"));
  await writeFile(
    join(path, "agentcore", "agentcore.json"),
    JSON.stringify({ name: "Project", version }),
  );
}

function app(
  io: ReturnType<typeof testIO>,
  handle: (ctx: Context) => Promise<void> = async () => {},
) {
  return new Router("app", "test")
    .use(withV0ProjectNotice(io.io))
    .handler(createHandler({ name: "check", description: "noop", handle }));
}

describe("v0 project notice", () => {
  test("prints migration guidance after a direct command", async () => {
    await writeProject(1);
    const io = testIO();

    await app(io).route(["node", "app", "check"]);

    expect(io.stderr()).toBe(V0_PROJECT_MIGRATION_MESSAGE);
  });

  test("does not print for a v1 project", async () => {
    await writeProject(2);
    const io = testIO();

    await app(io).route(["node", "app", "check"]);

    expect(io.stderr()).toBe("");
  });

  test("lets the TUI own the reminder when one was entered", async () => {
    await writeProject(1);
    const io = testIO();

    await app(io, async (ctx) => {
      ctx.require(V0ProjectNoticeStateKey).enteredTui = true;
    }).route(["node", "app", "check"]);

    expect(io.stderr()).toBe("");
  });
});
