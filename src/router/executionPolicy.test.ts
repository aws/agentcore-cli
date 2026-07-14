import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import z from "zod";

import type { StreamSupervisor } from "../runtime/output/types";
import { createStreamSupervisor } from "../runtime/output/streamSupervisor";
import { createInvocationExecutionPolicy, ExitCode, runWithExitCode } from "../runnable";
import { ValueContext } from "./context";
import { createCommanderExecutionPolicy, type CommanderExecutionPolicy } from "./executionPolicy";
import { argument, createHandler, flag } from "./handler";
import { compile, Router } from "./router";

const SUCCESS_CODES = ["commander.help", "commander.helpDisplayed", "commander.version"] as const;

const USAGE_CODES = [
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.missingArgument",
  "commander.excessArguments",
  "commander.invalidArgument",
  "commander.conflictingOption",
  "commander.error",
] as const;

function commanderError(exitCode: number, code: string): CommanderError {
  return new CommanderError(exitCode, code, "untrusted sentinel");
}

function createSupervisor(stdoutWrites: string[], stderrWrites: string[]): StreamSupervisor {
  return {
    stdout: {
      writeUtf8: async (text) => {
        stdoutWrites.push(text);
        return { kind: "written" };
      },
    },
    stderr: {
      writeUtf8: async (text) => {
        stderrWrites.push(text);
        return { kind: "written" };
      },
    },
    quiesce: async () => {},
    dispose: () => {},
  };
}

function captureStream(): Readonly<{
  stream: NodeJS.WriteStream;
  read(): string;
}> {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => text,
  };
}

async function invoke(
  root: Router,
  argv: string[],
  configure?: (command: Command) => void,
): Promise<Readonly<{ exitCode: ExitCode; stdout: string; stderr: string }>> {
  const stdout = captureStream();
  const stderr = captureStream();
  const supervisor = createStreamSupervisor(stdout.stream, stderr.stream);
  const invocation = createInvocationExecutionPolicy(supervisor);
  const exitCode = await runWithExitCode(
    async () => {
      const command = compile(root, ValueContext.EmptyContext(), invocation.commander);
      configure?.(command);
      await command.parseAsync(["node", "app", ...argv]);
    },
    invocation,
    [],
  );
  return {
    exitCode,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

describe("Commander execution policy classification", () => {
  const policy = createCommanderExecutionPolicy(createSupervisor([], []));

  for (const code of SUCCESS_CODES) {
    test(`classifies ${code} with exit code 0 as success`, () => {
      expect(policy.classify(commanderError(0, code))).toEqual({ kind: "success" });
    });

    test(`classifies ${code} with a nonzero exit code as internal`, () => {
      expect(policy.classify(commanderError(1, code))).toEqual({ kind: "internal" });
    });
  }

  for (const code of USAGE_CODES) {
    test(`classifies ${code} with exit code 1 as usage`, () => {
      expect(policy.classify(commanderError(1, code))).toEqual({ kind: "usage", code });
    });

    test(`classifies ${code} with the wrong exit code as internal`, () => {
      expect(policy.classify(commanderError(0, code))).toEqual({ kind: "internal" });
      expect(policy.classify(commanderError(2, code))).toEqual({ kind: "internal" });
    });
  }

  test.each([
    "help",
    "commanderHelp",
    "xcommander.help",
    "commander.help.extra",
    "unknownCommand",
    "xcommander.unknownCommand",
    "commander.unknownCommand.extra",
    "commander.unrecognized",
  ])("classifies unrecognized code %s as internal", (code) => {
    expect(policy.classify(commanderError(1, code))).toEqual({ kind: "internal" });
  });

  test.each([
    new Error("untrusted sentinel"),
    "untrusted sentinel",
    { code: "commander.unknownOption", exitCode: 1 },
    null,
    undefined,
  ])("classifies a non-Commander thrown value as internal", (error) => {
    expect(policy.classify(error as CommanderError)).toEqual({ kind: "internal" });
  });

  test("classifies malformed Commander errors as internal", () => {
    const malformedCode = commanderError(1, "commander.unknownOption");
    Object.defineProperty(malformedCode, "code", { value: undefined });

    const malformedExit = commanderError(1, "commander.unknownOption");
    Object.defineProperty(malformedExit, "exitCode", { value: Number.NaN });

    expect(policy.classify(malformedCode)).toEqual({ kind: "internal" });
    expect(policy.classify(malformedExit)).toEqual({ kind: "internal" });
  });

  test("classifies Commander errors with hostile properties as internal", () => {
    const hostile = commanderError(1, "commander.unknownOption");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("property sentinel");
      },
    });

    expect(policy.classify(hostile)).toEqual({ kind: "internal" });
  });
});

describe("Commander execution policy configuration", () => {
  test("injects supervised writers, suppresses raw errors, and always throws on exit", () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const policy = createCommanderExecutionPolicy(createSupervisor(stdoutWrites, stderrWrites));
    const command = new Command("app");

    policy.configure(command);

    const output = command.configureOutput();
    output.writeOut?.("stdout");
    output.writeErr?.("stderr");
    expect(stdoutWrites).toEqual(["stdout"]);
    expect(stderrWrites).toEqual(["stderr"]);

    output.outputError?.("raw untrusted sentinel", output.writeErr!);
    expect(stderrWrites).toEqual(["stderr"]);

    let thrown: unknown;
    try {
      command.error("raw untrusted sentinel");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommanderError);
    expect(stderrWrites).toEqual(["stderr"]);
  });

  test("contains a synchronous supervised-writer failure", () => {
    let attempts = 0;
    let unavailable = 0;
    const sink = {
      writeUtf8: (): Promise<{ kind: "written" }> => {
        attempts += 1;
        throw new Error("writer sentinel");
      },
    };
    const policy = createCommanderExecutionPolicy(
      {
        stdout: sink,
        stderr: sink,
        quiesce: async () => {},
        dispose: () => {},
      },
      () => {
        unavailable += 1;
      },
    );
    const command = new Command("app");
    policy.configure(command);

    expect(() => command.configureOutput().writeOut?.("output")).not.toThrow();
    expect(attempts).toBe(1);
    expect(unavailable).toBe(1);
  });

  test("configures every compiled command immediately after construction with one policy", () => {
    const configured: Command[] = [];
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const invocationPolicy = createCommanderExecutionPolicy(
      createSupervisor(stdoutWrites, stderrWrites),
    );
    const policy: CommanderExecutionPolicy = {
      configure(command) {
        expect(command.description()).toBe("");
        expect(command.options).toEqual([]);
        expect(command.registeredArguments).toEqual([]);
        expect(command.commands).toEqual([]);
        expect((command as Command & { _actionHandler?: unknown })._actionHandler).toBeNull();
        invocationPolicy.configure(command);
        configured.push(command);
      },
      classify: invocationPolicy.classify,
    };

    const leaf = createHandler({
      name: "leaf",
      description: "leaf description",
      handle: async () => {},
    });
    const defaultHost = new Router("default-host", "default host description")
      .default(async () => {})
      .handler(leaf);
    const nested = new Router("nested", "nested description").handler(defaultHost);
    const root = new Router("root", "root description").handler(nested);

    const command = compile(root, ValueContext.EmptyContext(), policy);

    expect(configured.map((entry) => entry.name())).toEqual([
      "root",
      "nested",
      "default-host",
      "leaf",
    ]);
    expect(configured).toEqual([
      command,
      command.commands[0]!,
      command.commands[0]!.commands[0]!,
      command.commands[0]!.commands[0]!.commands[0]!,
    ]);
    for (const configuredCommand of configured) {
      const output = configuredCommand.configureOutput();
      output.writeOut?.(`${configuredCommand.name()}:out`);
      output.writeErr?.(`${configuredCommand.name()}:err`);
      output.outputError?.("raw sentinel", output.writeErr!);
      expect(() => configuredCommand.error("raw sentinel")).toThrow(CommanderError);
    }
    expect(stdoutWrites).toEqual(["root:out", "nested:out", "default-host:out", "leaf:out"]);
    expect(stderrWrites).toEqual(["root:err", "nested:err", "default-host:err", "leaf:err"]);
  });
});

describe("real Commander execution", () => {
  function helpTree(): Router {
    const nested = new Router("nested", "nested description").handler(
      createHandler({
        name: "leaf",
        description: "leaf description",
        handle: async () => {},
      }),
    );
    return new Router("app", "root description").handler(nested);
  }

  test("help <command> succeeds and flushes supervised output", async () => {
    const result = await invoke(helpTree(), ["help", "nested"]);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage: app nested");
    expect(result.stderr).toBe("");
  });

  test("--help succeeds and flushes supervised output", async () => {
    const result = await invoke(helpTree(), ["nested", "leaf", "--help"]);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage: app nested leaf");
    expect(result.stderr).toBe("");
  });

  test("--version succeeds and flushes supervised output", async () => {
    const result = await invoke(helpTree(), ["--version"], (command) => {
      command.version("1.2.3");
    });

    expect(result).toEqual({
      exitCode: ExitCode.SUCCESS,
      stdout: "1.2.3\n",
      stderr: "",
    });
  });

  function parserTree(): Router {
    const nested = new Router("nested", "nested description");
    nested.handler(
      createHandler({
        name: "required-option",
        description: "",
        flags: [flag("name", "name", z.string())],
        handle: async () => {},
      }),
    );
    nested.handler(
      createHandler({
        name: "option-value",
        description: "",
        flags: [flag("name", "name", z.string().optional())],
        handle: async () => {},
      }),
    );
    nested.handler(
      createHandler({
        name: "required-argument",
        description: "",
        arguments: [argument("name", "name", z.string())],
        handle: async () => {},
      }),
    );
    nested.handler(
      createHandler({
        name: "bounded-argument",
        description: "",
        arguments: [argument("name", "name", z.string().max(3))],
        handle: async () => {},
      }),
    );
    nested.handler(
      createHandler({
        name: "no-arguments",
        description: "",
        handle: async () => {},
      }),
    );
    return new Router("app").handler(nested);
  }

  test.each([
    [["nested", "unknown"], "An unknown command was provided. Run with --help for usage.\n"],
    [
      ["nested", "no-arguments", "--unknown"],
      "An unknown option was provided. Run with --help for usage.\n",
    ],
    [
      ["nested", "option-value", "--name"],
      "An option value is missing. Run with --help for usage.\n",
    ],
    [["nested", "required-option"], "A required option is missing. Run with --help for usage.\n"],
    [
      ["nested", "required-argument"],
      "A required argument is missing. Run with --help for usage.\n",
    ],
    [
      ["nested", "no-arguments", "one", "two"],
      "Too many arguments were provided. Run with --help for usage.\n",
    ],
    [
      ["nested", "bounded-argument", "untrusted-value"],
      "An option or argument is invalid. Run with --help for usage.\n",
    ],
  ])("nested parser failure renders only its static guidance", async (argv, guidance) => {
    const result = await invoke(parserTree(), argv);

    expect(result).toEqual({
      exitCode: ExitCode.FAILURE,
      stdout: "",
      stderr: guidance,
    });
  });

  test("malformed dynamic input never reaches supervised output", async () => {
    const untrusted =
      "SENTINEL\u0000\u0001\u001b[31m\u009b31m\u001b]8;;https://example.invalid\u0007\u202e\\\\\ud800";
    const result = await invoke(parserTree(), ["nested", untrusted]);

    expect(result).toEqual({
      exitCode: ExitCode.FAILURE,
      stdout: "",
      stderr: "An unknown command was provided. Run with --help for usage.\n",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("SENTINEL");
  });

  test("every compiled node bypasses process.exit in an isolated subprocess", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { createHandler } from "./src/router/handler.tsx";
          import { compile, Router } from "./src/router/router.tsx";
          import { ValueContext } from "./src/router/context.tsx";
          import { createCommanderExecutionPolicy } from "./src/router/executionPolicy.ts";

          let exitCalls = 0;
          process.exit = () => {
            exitCalls += 1;
            throw new Error("process.exit sentinel");
          };
          const sink = { writeUtf8: async () => ({ kind: "written" }) };
          const supervisor = {
            stdout: sink,
            stderr: sink,
            quiesce: async () => {},
            dispose: () => {},
          };
          const policy = createCommanderExecutionPolicy(supervisor);
          const branch = new Router("branch").default(async () => {});
          branch.handler(createHandler({
            name: "leaf",
            description: "",
            handle: async () => {},
          }));
          const command = compile(
            new Router("app").handler(branch),
            ValueContext.EmptyContext(),
            policy,
          );
          const commands = [command, command.commands[0], command.commands[0].commands[0]];
          for (const current of commands) {
            try {
              current.error("untrusted sentinel");
            } catch {}
          }
          if (exitCalls !== 0) {
            throw new Error("compiled command called process.exit");
          }
          console.log(JSON.stringify({ commands: commands.length, exitCalls }));
        `,
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('{"commands":3,"exitCalls":0}\n');
    expect(stderr).toBe("");
    expect(`${stdout}${stderr}`).not.toContain("sentinel");
  });
});

describe("real supervised output lifecycle", () => {
  test("help completion waits for callback and backpressure drain", async () => {
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    let acceptedResolve: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      acceptedResolve = resolve;
    });
    let stdoutText = "";
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        releaseWrite = callback;
        acceptedResolve?.();
      },
    });
    const stderr = captureStream();
    const supervisor = createStreamSupervisor(
      stdout as unknown as NodeJS.WriteStream,
      stderr.stream,
    );
    const invocation = createInvocationExecutionPolicy(supervisor);
    let completed = false;
    const running = runWithExitCode(
      async () => {
        await compile(
          new Router("app").handler(
            createHandler({
              name: "leaf",
              description: "",
              handle: async () => {},
            }),
          ),
          ValueContext.EmptyContext(),
          invocation.commander,
        ).parseAsync(["node", "app", "--help"]);
      },
      invocation,
      [],
    ).then((exitCode) => {
      completed = true;
      return exitCode;
    });

    await accepted;
    expect(completed).toBe(false);

    releaseWrite?.();
    expect(await running).toBe(ExitCode.SUCCESS);
    expect(stdoutText).toContain("Usage: app");
    expect(stderr.read()).toBe("");
  });

  test("stdout callback failure is contained and returns static failure", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("stdout callback sentinel"));
      },
    });
    const stderr = captureStream();
    const supervisor = createStreamSupervisor(
      stdout as unknown as NodeJS.WriteStream,
      stderr.stream,
    );
    const invocation = createInvocationExecutionPolicy(supervisor);

    const exitCode = await runWithExitCode(
      async () => {
        await compile(
          new Router("app").handler(
            createHandler({
              name: "leaf",
              description: "",
              handle: async () => {},
            }),
          ),
          ValueContext.EmptyContext(),
          invocation.commander,
        ).parseAsync(["node", "app", "--help"]);
      },
      invocation,
      [],
    );

    expect(exitCode).toBe(ExitCode.FAILURE);
    expect(stderr.read()).toBe("Command output could not be written.\n");
    expect(stderr.read()).not.toContain("sentinel");
  });
});
