import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  testIO,
  TestGlobalConfigAccessor,
} from "../../../../testing";
import type { SimulateResult } from "../../types";

const RESULT: SimulateResult = {
  batchEvaluationId: "batch-eval-sim",
  status: "RUNNING",
  scenariosInvoked: 3,
  scenariosFailed: 0,
};

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  core.eval.setSimulateResponse(RESULT);
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

const BASE = [
  "eval",
  "batch-evaluation",
  "simulate",
  "--runtime-id",
  "r-1",
  "--payload-template",
  '{"prompt":"{input}"}',
  "--dataset",
  "/tmp/ds.jsonl",
  "--evaluator",
  "Builtin.Helpfulness",
  "--name",
  "sim-1",
];

describe("eval batch-evaluation simulate", () => {
  test("registered under batch-evaluation", () => {
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
      .find((c) => c.name() === "batch-evaluation");
    expect(group?.children().map((c) => c.name())).toContain("simulate");
  });

  test.each([
    [
      [
        "--payload-template",
        '{"prompt":"{input}"}',
        "--dataset",
        "/tmp/ds.jsonl",
        "--evaluator",
        "E",
        "--name",
        "n",
      ],
      /--runtime-id/,
    ],
    [
      ["--runtime-id", "r-1", "--dataset", "/tmp/ds.jsonl", "--evaluator", "E", "--name", "n"],
      /--payload-template/,
    ],
    [
      ["--runtime-id", "r-1", "--payload-template", "{}", "--evaluator", "E", "--name", "n"],
      /--dataset/,
    ],
    [
      [
        "--runtime-id",
        "r-1",
        "--payload-template",
        "{}",
        "--dataset",
        "/tmp/ds.jsonl",
        "--name",
        "n",
      ],
      /--evaluator/,
    ],
    [
      [
        "--runtime-id",
        "r-1",
        "--payload-template",
        "{}",
        "--dataset",
        "/tmp/ds.jsonl",
        "--evaluator",
        "E",
      ],
      /--name/,
    ],
  ])("rejects missing required flag", async (args, expected) => {
    await expect(run(["eval", "batch-evaluation", "simulate", ...args])).rejects.toThrow(expected);
  });

  test("maps flags to the simulate input and renders the result", async () => {
    const { core, stdout } = await run([...BASE, "--qualifier", "PROD", "--header", "x-a:1"]);
    expect(JSON.parse(stdout)).toEqual(RESULT);
    const call = core.eval.calls.find((c) => c.method === "simulate");
    expect(call?.args[0]).toMatchObject({
      runtimeId: "r-1",
      qualifier: "PROD",
      payloadTemplate: '{"prompt":"{input}"}',
      headers: [["x-a", "1"]],
      dataset: "/tmp/ds.jsonl",
      evaluatorIds: ["Builtin.Helpfulness"],
      name: "sim-1",
    });
    // Handler wires an AbortSignal (Ctrl-C) through to Core.
    expect(call?.args[2]).toBeInstanceOf(AbortSignal);
  });
});
