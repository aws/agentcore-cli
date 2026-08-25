import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/";

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout() };
}

describe("eval ab-test command hierarchy", () => {
  test("registers get, list, pause, resume, stop, delete", () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const group = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "ab-test");
    expect(group?.children().map((c) => c.name())).toEqual([
      "get",
      "list",
      "pause",
      "resume",
      "stop",
      "delete",
    ]);
  });
});

describe("eval ab-test transitions", () => {
  test.each([
    ["pause", "PAUSED"],
    ["resume", "RUNNING"],
    ["stop", "STOPPED"],
  ] as const)("%s sets executionStatus %s via Core", async (command, status) => {
    const { core } = await run(["eval", "ab-test", command, "--id", "ab-test-1", "--json"], (c) =>
      c.eval.setAbTestUpdateResponse({
        abTestId: "ab-test-1",
        abTestArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:ab-test/ab-test-1",
        status: "ACTIVE",
        executionStatus: status,
        updatedAt: new Date("2026-07-20T12:34:56.000Z"),
      }),
    );
    expect(core.eval.calls).toEqual([
      { method: "setABTestExecutionStatus", args: ["ab-test-1", status, { region: "us-west-2" }] },
    ]);
  });

  test.each(["pause", "resume", "stop"] as const)("%s requires --id", async (command) => {
    await expect(run(["eval", "ab-test", command, "--json"])).rejects.toThrow(/--id/);
  });
});

describe("eval ab-test delete", () => {
  test("deletes by id via Core", async () => {
    const { core, stdout } = await run(
      ["eval", "ab-test", "delete", "--id", "ab-test-1", "--json"],
      (c) =>
        c.eval.setAbTestDeleteResponse({
          abTestId: "ab-test-1",
          abTestArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:ab-test/ab-test-1",
          status: "DELETING",
        }),
    );
    expect(JSON.parse(stdout).abTestId).toBe("ab-test-1");
    expect(core.eval.calls).toEqual([
      { method: "deleteABTest", args: ["ab-test-1", { region: "us-west-2" }] },
    ]);
  });

  test("requires --id", async () => {
    await expect(run(["eval", "ab-test", "delete", "--json"])).rejects.toThrow(/--id/);
  });
});
