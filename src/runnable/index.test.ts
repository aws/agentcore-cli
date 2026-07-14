import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";

import type { OutputWriteOutcome, StreamSupervisor } from "../runtime/output/types";
import {
  createInvocationExecutionPolicy,
  ExitCode,
  runRunnable,
  runWithExitCode,
  type InvocationExecutionPolicy,
  type Runnable,
} from "./index.tsx";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
}>;

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function createOutputHarness(
  outcomes: Readonly<{
    stdout?: OutputWriteOutcome;
    stderr?: OutputWriteOutcome;
  }> = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let disposed = false;
  const supervisor: StreamSupervisor = {
    stdout: {
      writeUtf8: async (text) => {
        stdout.push(text);
        return outcomes.stdout ?? { kind: "written" };
      },
    },
    stderr: {
      writeUtf8: async (text) => {
        stderr.push(text);
        return outcomes.stderr ?? { kind: "written" };
      },
    },
    quiesce: async () => {},
    dispose: () => {
      disposed = true;
    },
  };

  return {
    stdout,
    stderr,
    supervisor,
    policy: createInvocationExecutionPolicy(supervisor),
    disposed: () => disposed,
  };
}

function createInjectedPolicy(
  overrides: Partial<InvocationExecutionPolicy> = {},
): Readonly<{ policy: InvocationExecutionPolicy; disposeCalls(): number }> {
  let disposeCalls = 0;
  const commandPolicy = createInvocationExecutionPolicy(createOutputHarness().supervisor).commander;
  const policy: InvocationExecutionPolicy = {
    commander: commandPolicy,
    writeStderr: async () => ({ kind: "written" }),
    outputUnavailable: () => false,
    quiesce: async () => {},
    dispose: () => {
      disposeCalls += 1;
    },
    ...overrides,
  };

  return {
    policy,
    disposeCalls: () => disposeCalls,
  };
}

test("returns SUCCESS and forwards argv when a runnable completes", async () => {
  const output = createOutputHarness();
  let receivedArgv: string[] | undefined;
  const runnable: Runnable = {
    run: async (argv: string[]) => {
      receivedArgv = argv;
    },
  };
  const argv = ["node", "script", "--flag"];

  const code = await runRunnable(() => runnable, output.policy, argv);

  expect(code).toBe(ExitCode.SUCCESS);
  expect(receivedArgv).toEqual(argv);
  expect(output.stdout).toEqual([]);
  expect(output.stderr).toEqual([]);
  expect(output.disposed()).toBe(true);
});

test("runWithExitCode returns SUCCESS for a resolving function", async () => {
  const output = createOutputHarness();

  const code = await runWithExitCode(async () => {}, output.policy, []);

  expect(code).toBe(ExitCode.SUCCESS);
});

describe("static Commander usage guidance", () => {
  const cases = [
    ["commander.missingArgument", "A required argument is missing. Run with --help for usage."],
    ["commander.optionMissingArgument", "An option value is missing. Run with --help for usage."],
    [
      "commander.missingMandatoryOptionValue",
      "A required option is missing. Run with --help for usage.",
    ],
    [
      "commander.conflictingOption",
      "Conflicting options were provided. Run with --help for usage.",
    ],
    ["commander.unknownOption", "An unknown option was provided. Run with --help for usage."],
    ["commander.excessArguments", "Too many arguments were provided. Run with --help for usage."],
    ["commander.unknownCommand", "An unknown command was provided. Run with --help for usage."],
    ["commander.invalidArgument", "An option or argument is invalid. Run with --help for usage."],
    ["commander.error", "An option or argument is invalid. Run with --help for usage."],
  ] as const;

  for (const [commanderCode, guidance] of cases) {
    test(`renders only static guidance for ${commanderCode}`, async () => {
      const output = createOutputHarness();

      const code = await runWithExitCode(
        async () => {
          throw new CommanderError(1, commanderCode, "untrusted sentinel");
        },
        output.policy,
        [],
      );

      expect(code).toBe(ExitCode.FAILURE);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([`${guidance}\n`]);
      expect(output.stderr.join("")).not.toContain("untrusted sentinel");
    });
  }
});

test.each(["commander.help", "commander.helpDisplayed", "commander.version"])(
  "returns SUCCESS for %s with exit code 0 after output settles",
  async (commanderCode) => {
    const output = createOutputHarness();

    const code = await runWithExitCode(
      async () => {
        throw new CommanderError(0, commanderCode, "untrusted sentinel");
      },
      output.policy,
      [],
    );

    expect(code).toBe(ExitCode.SUCCESS);
    expect(output.stderr).toEqual([]);
  },
);

test.each([
  new Error("error sentinel"),
  "string sentinel",
  { message: "object sentinel", stack: "stack sentinel", cause: "cause sentinel" },
])("unknown thrown values render only the static internal error", async (thrown) => {
  const output = createOutputHarness();

  const code = await runWithExitCode(
    async () => {
      throw thrown;
    },
    output.policy,
    [],
  );

  expect(code).toBe(ExitCode.FAILURE);
  expect(output.stdout).toEqual([]);
  expect(output.stderr).toEqual(["An internal error occurred.\n"]);
  expect(output.stderr.join("")).not.toContain("sentinel");
});

test("unrecognized and wrong-exit Commander errors render only the static internal error", async () => {
  for (const error of [
    new CommanderError(1, "commander.unrecognized", "code sentinel"),
    new CommanderError(2, "commander.unknownOption", "exit sentinel"),
    new CommanderError(1, "help", "prefix sentinel"),
  ]) {
    const output = createOutputHarness();

    const code = await runWithExitCode(
      async () => {
        throw error;
      },
      output.policy,
      [],
    );

    expect(code).toBe(ExitCode.FAILURE);
    expect(output.stderr).toEqual(["An internal error occurred.\n"]);
    expect(output.stderr.join("")).not.toContain("sentinel");
  }
});

test("Commander output unavailable converts an otherwise successful invocation to failure", async () => {
  const output = createOutputHarness({
    stdout: { kind: "outputUnavailable" },
  });
  const command = new Command("app");
  output.policy.commander.configure(command);

  const code = await runWithExitCode(
    async () => {
      command.configureOutput().writeOut?.("help output");
    },
    output.policy,
    [],
  );

  expect(code).toBe(ExitCode.FAILURE);
  expect(output.stdout).toEqual(["help output"]);
  expect(output.disposed()).toBe(true);
});

test("stderr output unavailable remains contained and returns failure", async () => {
  const output = createOutputHarness({
    stderr: { kind: "outputUnavailable" },
  });

  const code = await runWithExitCode(
    async () => {
      throw new Error("untrusted sentinel");
    },
    output.policy,
    [],
  );

  expect(code).toBe(ExitCode.FAILURE);
  expect(output.stderr).toEqual(["An internal error occurred.\n"]);
  expect(output.disposed()).toBe(true);
});

test("completion waits for high-water quiescence before disposing", async () => {
  const quiesceStarted = deferred();
  const releaseQuiescence = deferred();
  let disposed = false;
  const supervisor: StreamSupervisor = {
    stdout: {
      writeUtf8: async () => ({ kind: "written" }),
    },
    stderr: {
      writeUtf8: async () => ({ kind: "written" }),
    },
    quiesce: async () => {
      quiesceStarted.resolve();
      await releaseQuiescence.promise;
    },
    dispose: () => {
      disposed = true;
    },
  };
  const policy = createInvocationExecutionPolicy(supervisor);
  let completed = false;

  const running = runWithExitCode(async () => {}, policy, []).then((code) => {
    completed = true;
    return code;
  });
  await quiesceStarted.promise;

  expect(completed).toBe(false);
  expect(disposed).toBe(false);

  releaseQuiescence.resolve();
  expect(await running).toBe(ExitCode.SUCCESS);
  expect(disposed).toBe(true);
});

describe("injected execution policy failures", () => {
  test.each([
    [
      "synchronous throw",
      () => {
        throw new Error("write sentinel");
      },
    ],
    ["rejection", async () => Promise.reject(new Error("write sentinel"))],
  ])("contains writeStderr %s and disposes exactly once", async (_name, writeStderr) => {
    const injected = createInjectedPolicy({
      writeStderr: writeStderr as InvocationExecutionPolicy["writeStderr"],
    });

    const result = await runWithExitCode(
      async () => {
        throw new Error("run sentinel");
      },
      injected.policy,
      [],
    );

    expect(result).toBe(ExitCode.FAILURE);
    expect(injected.disposeCalls()).toBe(1);
  });

  test("contains outputUnavailable throws and fallback write failures", async () => {
    let writeCalls = 0;
    let quiesceCalls = 0;
    const injected = createInjectedPolicy({
      writeStderr: () => {
        writeCalls += 1;
        throw new Error("fallback sentinel");
      },
      outputUnavailable: () => {
        throw new Error("availability sentinel");
      },
      quiesce: async () => {
        quiesceCalls += 1;
      },
    });

    const result = await runWithExitCode(async () => {}, injected.policy, []);

    expect(result).toBe(ExitCode.FAILURE);
    expect(writeCalls).toBe(1);
    expect(quiesceCalls).toBe(2);
    expect(injected.disposeCalls()).toBe(1);
  });

  test("contains quiesce failure and still disposes exactly once", async () => {
    const injected = createInjectedPolicy({
      quiesce: async () => {
        throw new Error("quiesce sentinel");
      },
    });

    const result = await runWithExitCode(async () => {}, injected.policy, []);

    expect(result).toBe(ExitCode.FAILURE);
    expect(injected.disposeCalls()).toBe(1);
  });

  test("contains dispose failure after attempting it exactly once", async () => {
    let disposeCalls = 0;
    const injected = createInjectedPolicy({
      dispose: () => {
        disposeCalls += 1;
        throw new Error("dispose sentinel");
      },
    });

    const result = await runWithExitCode(async () => {}, injected.policy, []);

    expect(result).toBe(ExitCode.FAILURE);
    expect(disposeCalls).toBe(1);
  });
});
