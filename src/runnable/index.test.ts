import { expect, spyOn, test } from "bun:test";
import { CommanderError } from "commander";

import { AgentCoreCLIError } from "../errors";
import { ExitCode, runRunnable, runWithExitCode, type Runnable } from "./index.tsx";

async function captureErrors(run: () => Promise<number>) {
  const errors: string[] = [];
  const errorLog = spyOn(console, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  try {
    return { code: await run(), errors };
  } finally {
    errorLog.mockRestore();
  }
}

test("returns SUCCESS and forwards argv when run completes", async () => {
  let receivedArgv: string[] | undefined;
  const runnable: Runnable = {
    run: async (argv: string[]) => {
      receivedArgv = argv;
    },
  };

  const argv = ["node", "script", "--flag"];
  const code = await runRunnable(() => runnable, argv);

  expect(code).toBe(ExitCode.SUCCESS);
  expect(receivedArgv).toEqual(argv);
});

test("returns the default failure code when run rejects with an Error", async () => {
  const runnable: Runnable = {
    run: async () => {
      throw new Error("boom");
    },
  };

  const { code, errors } = await captureErrors(() => runRunnable(() => runnable, []));

  expect(code).toBe(ExitCode.FAILURE);
  expect(errors).toEqual(["Error: boom"]);
});

test("returns FAILURE when the factory throws a non-Error value", async () => {
  const { code, errors } = await captureErrors(() =>
    runRunnable(() => {
      throw "kaboom";
    }, []),
  );

  expect(code).toBe(ExitCode.FAILURE);
  expect(errors).toEqual(["Error: kaboom"]);
});

test("respects custom errors codes from known errors", async () => {
  const runnable: Runnable = {
    run: async () => {
      throw new AgentCoreCLIError("custom failure", { exitCode: 42 });
    },
  };

  const code = await runRunnable(() => runnable, []);

  expect(code).toBe(42);
});

test.each([
  [
    "explicit usage",
    new AgentCoreCLIError("bad request", { exitCode: ExitCode.USAGE }),
    ExitCode.USAGE,
    ["AgentCoreCLIError: bad request"],
  ],
  [
    "interruption",
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    ExitCode.INTERRUPTED,
    ["AbortError: The operation was aborted"],
  ],
  [
    "Commander parse failure",
    new CommanderError(1, "commander.invalidArgument", "invalid option"),
    ExitCode.USAGE,
    [],
  ],
  [
    "Commander help",
    new CommanderError(0, "commander.helpDisplayed", "help displayed"),
    ExitCode.SUCCESS,
    [],
  ],
  [
    "reported failure",
    Object.assign(new Error("already reported"), { reported: true }),
    ExitCode.FAILURE,
    [],
  ],
  [
    "arbitrary TypeError",
    new TypeError("transport failed"),
    ExitCode.FAILURE,
    ["TypeError: transport failed"],
  ],
])("runWithExitCode maps %s", async (_name, error, expected, expectedErrors) => {
  const result = await captureErrors(() => runWithExitCode(async () => Promise.reject(error)));
  expect(result).toEqual({ code: expected, errors: expectedErrors });
});
