import { expect, spyOn, test } from "bun:test";
import { CommanderError } from "commander";

import {
  AgentCoreCLIError,
  InputValidationError,
  SilentCLIError,
  UserCancellationError,
} from "../errors";
import {
  ExitCode,
  runRunnable,
  runWithExitCode,
  withUserCancellation,
  type Runnable,
} from "./index.tsx";

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

  const { code, errors } = await captureErrors(() => runRunnable(() => runnable, []));

  expect(code).toBe(42);
  expect(errors).toEqual(["Error: custom failure"]);
});

test("withUserCancellation returns the result and removes its SIGINT listener", async () => {
  const initialListeners = process.listenerCount("SIGINT");
  let signal: AbortSignal | undefined;

  const result = await withUserCancellation(async (current) => {
    signal = current;
    return "done";
  });

  expect(result).toBe("done");
  expect(signal?.aborted).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(initialListeners);
});

test("withUserCancellation replaces transport aborts with the shared reason", async () => {
  const initialListeners = process.listenerCount("SIGINT");
  let signal: AbortSignal | undefined;
  const pending = withUserCancellation((current) => {
    signal = current;
    return new Promise<never>((_, reject) => {
      const abort = () => reject(new Error("transport aborted"));
      if (current.aborted) abort();
      else current.addEventListener("abort", abort, { once: true });
    });
  });

  process.emit("SIGINT", "SIGINT");

  expect(signal?.reason).toBeInstanceOf(UserCancellationError);
  await expect(pending).rejects.toBe(signal?.reason);
  expect(process.listenerCount("SIGINT")).toBe(initialListeners);
});

test("withUserCancellation preserves non-cancellation failures", async () => {
  const failure = new TypeError("operation failed");

  await expect(
    withUserCancellation(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

test.each([
  [
    "explicit usage",
    new InputValidationError("bad request", { exitCode: ExitCode.USAGE }),
    ExitCode.USAGE,
    ["Error: bad request"],
  ],
  ["user cancellation", new UserCancellationError(), ExitCode.INTERRUPTED, []],
  [
    "raw AbortError",
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    ExitCode.FAILURE,
    ["Error: The operation was aborted"],
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
  ["hidden failure", new SilentCLIError("already displayed"), ExitCode.FAILURE, []],
  [
    "arbitrary TypeError",
    new TypeError("transport failed"),
    ExitCode.FAILURE,
    ["Error: transport failed"],
  ],
])("runWithExitCode maps %s", async (_name, error, expected, expectedErrors) => {
  const result = await captureErrors(() => runWithExitCode(async () => Promise.reject(error)));
  expect(result).toEqual({ code: expected, errors: expectedErrors });
});
