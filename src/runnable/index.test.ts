import { expect, spyOn, test } from "bun:test";
import { ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore-control";
import { CommanderError } from "commander";
import { fileURLToPath } from "node:url";
import { waitFor } from "../testing/timing";

import {
  AgentCoreCLIError,
  ExitCode,
  InputValidationError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../errors";
import { runRunnable, runWithExitCode, withUserCancellation, type Runnable } from "./index.tsx";

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

test("withUserCancellation returns the result and removes its signal listeners", async () => {
  const initialListeners = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
  let signal: AbortSignal | undefined;
  let cancellations = 0;

  const result = await withUserCancellation(
    async (current) => {
      signal = current;
      return "done";
    },
    () => cancellations++,
  );

  expect(result).toBe("done");
  expect(signal?.aborted).toBe(true);
  expect(cancellations).toBe(0);
  expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(
    initialListeners,
  );
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "withUserCancellation replaces %s transport aborts with the shared reason",
  async (signalName) => {
    const initialListeners = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
    let signal: AbortSignal | undefined;
    let cancellations = 0;
    const pending = withUserCancellation(
      (current) => {
        signal = current;
        return new Promise<never>((_, reject) => {
          const abort = () => reject(new Error("transport aborted"));
          if (current.aborted) abort();
          else current.addEventListener("abort", abort, { once: true });
        });
      },
      () => cancellations++,
    );

    process.emit(signalName, signalName);
    process.emit(signalName, signalName);

    expect(signal?.reason).toBeInstanceOf(UserCancellationError);
    await expect(pending).rejects.toBe(signal?.reason);
    expect(cancellations).toBe(1);
    expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(
      initialListeners,
    );
  },
);

test("withUserCancellation preserves non-cancellation failures", async () => {
  const failure = new TypeError("operation failed");

  await expect(
    withUserCancellation(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

// Windows console Ctrl+C is not equivalent to sending a POSIX signal to a child.
test.skipIf(process.platform === "win32")(
  "real SIGINT waits for Ink invocation cleanup, including repeated interrupts",
  async () => {
    const runnable = fileURLToPath(new URL("./index.tsx", import.meta.url));
    const progress = fileURLToPath(new URL("../tui/progress.tsx", import.meta.url));
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
import { runWithExitCode, withUserCancellation } from ${JSON.stringify(runnable)};
import { runWithProgress } from ${JSON.stringify(progress)};
Object.defineProperty(process.stderr, "isTTY", { value: true });
const initialListeners = new Set(process.listeners("SIGINT"));
let cancellationListener;
const code = await runWithExitCode(() => withUserCancellation(signal => {
  cancellationListener = process.listeners("SIGINT").find(listener => !initialListeners.has(listener));
  return runWithProgress(async () => {
    await new Promise(resolve => {
      signal.addEventListener("abort", () => {
        setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
        setTimeout(resolve, 100);
      }, { once: true });
      process.kill(process.pid, "SIGINT");
    });
    process.stdout.write("cleanup complete\\n");
  }, { io: process, label: "Waiting" });
}));
process.stdout.write(JSON.stringify({ code, restored: !process.listeners("SIGINT").includes(cancellationListener) }));
process.exitCode = code;
`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, INK_SCREEN_READER: "false", FORCE_COLOR: "0" },
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000);
      expect(await child.exited).toBe(130);
      expect(await stdout).toBe('cleanup complete\n{"code":130,"restored":true}');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
  },
);

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

const notFound = () =>
  new ResourceNotFoundException({
    message: "Harness doesnotexist0000 not found",
    $metadata: { httpStatusCode: 404, requestId: "req-123" },
  });

test.each([
  [
    "service exception",
    notFound(),
    "  name: ResourceNotFoundException  status: 404  requestId: req-123",
  ],
  [
    "service exception wrapped by a CLI error",
    new ResourceNotFoundError("harness not found", { cause: notFound() }),
    "  name: ResourceNotFoundException  status: 404  requestId: req-123",
  ],
  [
    "service exception without a request ID",
    new ResourceNotFoundException({ message: "gone", $metadata: { httpStatusCode: 404 } }),
    "  name: ResourceNotFoundException  status: 404",
  ],
  [
    "SDK error with only retry metadata",
    Object.assign(new Error("socket hang up"), {
      name: "TimeoutError",
      $metadata: { attempts: 3 },
    }),
    "  name: TimeoutError",
  ],
  ["CLI error", new InputValidationError("bad request"), "  name: InputValidationError"],
  ["plain Error", new TypeError("fetch failed"), "  name: TypeError"],
  ["non-Error value", "kaboom", "  name: AgentCoreCLIError"],
])("--debug adds error details for a %s", async (_name, error, summary) => {
  const report = { debug: true, logFile: "/home/me/.agentcore/logs/output-2026-11-23.log" };

  const result = await captureErrors(() =>
    runWithExitCode(async () => Promise.reject(error), report),
  );

  expect(result.errors).toHaveLength(2);
  expect(result.errors[1]).toBe(`${summary}\n  details: ${report.logFile}`);
});

test("--debug omits the details line when nothing was logged", async () => {
  const result = await captureErrors(() =>
    runWithExitCode(async () => Promise.reject(notFound()), { debug: true }),
  );

  expect(result.errors).toEqual([
    "Error: Harness doesnotexist0000 not found",
    "  name: ResourceNotFoundException  status: 404  requestId: req-123",
  ]);
});

test("--debug stops at a cause cycle", async () => {
  const error = new Error("loop");
  error.cause = new Error("back", { cause: error });

  const result = await captureErrors(() =>
    runWithExitCode(async () => Promise.reject(error), { debug: true }),
  );

  expect(result.errors).toEqual(["Error: loop", "  name: Error"]);
});

test.each([
  ["without --debug", { debug: false, logFile: "/tmp/output.log" }],
  ["without a report", undefined],
])("prints only the message %s", async (_name, report) => {
  const result = await captureErrors(() =>
    runWithExitCode(async () => Promise.reject(notFound()), report),
  );

  expect(result.errors).toEqual(["Error: Harness doesnotexist0000 not found"]);
});

test("--debug keeps silent errors silent", async () => {
  const result = await captureErrors(() =>
    runWithExitCode(async () => Promise.reject(new SilentCLIError("shown already")), {
      debug: true,
    }),
  );

  expect(result.errors).toEqual([]);
});
