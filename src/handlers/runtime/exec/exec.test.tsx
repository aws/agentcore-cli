import { describe, expect, spyOn, test } from "bun:test";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import {
  IMPERATIVE_GLOBAL_CONFIG,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import * as tui from "../../../tui";

const ID = "checkout-AbCdEf1234";
const ARN = `arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/${ID}`;
const SESSION = "12345678-1234-1234-1234-123456789012";

function setup() {
  const core = new TestCoreClient();
  core.runtime.setGetResponse({ agentRuntimeArn: ARN } as GetAgentRuntimeResponse);
  core.runtime.setExecEvents(
    { chunk: { contentDelta: { stdout: "hello\n", stderr: "warning\n" } } },
    { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
  );
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({
      initialConfigData: IMPERATIVE_GLOBAL_CONFIG,
    }),
  });
  return {
    core,
    stdout: io.stdout,
    run: (args: string[]) =>
      root.route(["node", "agentcore", "runtime", "exec", ...args, "--region", "us-west-2"]),
  };
}

describe("runtime exec", () => {
  test("resolves the Runtime ARN, passes command options, and emits the result", async () => {
    const { run, core, stdout } = setup();
    await run([
      "--id",
      ID,
      "--command",
      "pwd",
      "--session-id",
      SESSION,
      "--qualifier",
      "prod",
      "--timeout",
      "60",
      "--json",
    ]);
    expect(core.harness.calls).toEqual([]);
    expect(core.runtime.calls[1]!.args.slice(0, 2)).toEqual([
      {
        agentRuntimeArn: ARN,
        qualifier: "prod",
        runtimeSessionId: SESSION,
        body: { command: "pwd", timeout: 60 },
      },
      { region: "us-west-2" },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      sessionId: SESSION,
      command: "pwd",
      output: "hello\nwarning\n",
      exitCode: 0,
      status: "success",
    });
  });

  test("defaults to DEFAULT and preserves a nonzero remote exit in JSON", async () => {
    const { run, core, stdout } = setup();
    core.runtime.setExecEvents({ chunk: { contentStop: { status: "COMPLETED", exitCode: 7 } } });
    await run(["--id", ID, "--command", "false"]);
    expect(core.runtime.calls[1]!.args[0]).toMatchObject({
      qualifier: "DEFAULT",
      runtimeSessionId: undefined,
    });
    expect(JSON.parse(stdout())).toMatchObject({ exitCode: 7, status: "error" });
  });

  test("reports an incomplete stream as an error", async () => {
    const { run, core, stdout } = setup();
    core.runtime.setExecEvents({ chunk: { contentDelta: { stdout: "partial" } } });
    await run(["--id", ID, "--command", "ls"]);
    expect(JSON.parse(stdout())).toMatchObject({ status: "error", output: "partial" });
  });

  test.each(
    [
      ["--command", "ls"],
      ["--id", ID, "--json"],
      ["--id", ARN, "--command", "ls"],
      ["--id", ID, "--command", " "],
      ["--id", ID, "--session-id", "short"],
      ["--id", ID, "--timeout", "0"],
      ["--id", ID, "--timeout", "3601"],
      ["--id", ID, "--timeout", "1.5"],
    ].map((args) => ({ args })),
  )("rejects invalid arguments %j before calling Core", async ({ args }) => {
    const { run, core } = setup();
    await expect(run(args)).rejects.toMatchObject({ exitCode: 2 });
    expect(core.runtime.calls).toEqual([]);
  });

  test("does not send a command when Runtime lookup fails or returns no ARN", async () => {
    const { run, core } = setup();
    core.runtime.setError(new Error("not found"));
    await expect(run(["--id", ID, "--command", "ls"])).rejects.toThrow("not found");
    core.runtime.setError(undefined).setGetResponse({} as GetAgentRuntimeResponse);
    await expect(run(["--id", ID, "--command", "ls"])).rejects.toThrow("Runtime returned no ARN");
    expect(core.runtime.calls.every(({ method }) => method === "getRuntime")).toBe(true);
  });

  test("deep-links the TUI with encoded target, session, and timeout", async () => {
    const { run, core } = setup();
    const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);
    try {
      await run(["--id", "runtime/blue one", "--session-id", SESSION, "--timeout", "60"]);
      await run(["--id", ID, "--qualifier", "prod/green"]);
      expect(render.mock.calls.map(([path]) => path)).toEqual([
        `/agentcore/runtime/exec/runtime%2Fblue%20one?session-id=${SESSION}&timeout=60`,
        `/agentcore/runtime/exec/${ID}/prod%2Fgreen`,
      ]);
      expect(core.runtime.calls).toEqual([]);
    } finally {
      render.mockRestore();
    }
  });
});
