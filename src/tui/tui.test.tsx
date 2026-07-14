import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRootHandler } from "../handlers";
import { renderJson } from "./index";
import { TestCoreClient, testIO } from "../testing";
import { createInvocationExecutionPolicy, ExitCode, runWithExitCode } from "../runnable";
import { createStreamSupervisor } from "../runtime/output/streamSupervisor";
import type { StreamSupervisor } from "../runtime/output/types";

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

async function settledAfterMicrotasks(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
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

class FailingWritable extends EventEmitter {
  readonly writes: string[] = [];

  write(
    text: string,
    _encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.writes.push(text);
    const error = new Error("stdout failure sentinel");
    this.emit("error", error);
    if (callback !== undefined) {
      queueMicrotask(() => {
        callback(error);
      });
    }
    return true;
  }

  asWriteStream(): NodeJS.WriteStream {
    return this as unknown as NodeJS.WriteStream;
  }
}

describe("renderJson", () => {
  test("pretty-prints a value as indented JSON to the given writer", () => {
    const lines: string[] = [];
    renderJson({ a: 1, b: ["x"] }, (line) => lines.push(line));
    expect(lines).toEqual(['{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}']);
  });
});

describe("--json short-circuits the TUI", () => {
  // With --json set, a group invoked without a subcommand prints help text
  // instead of launching the interactive TUI (renderTui's JSON branch). This
  // keeps the CLI scriptable and, importantly, keeps these tests from trying to
  // mount Ink against a non-TTY stdin.
  async function runRoot(
    args: string[],
  ): Promise<Readonly<{ exitCode: ExitCode; stdout: string }>> {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), io.io);
    const supervisor = createStreamSupervisor(io.io.stdout, io.io.stderr);
    const policy = createInvocationExecutionPolicy(supervisor);
    const exitCode = await runWithExitCode(
      async () => {
        await root.route(["node", "agentcore", ...args, "--json"], policy.commander);
      },
      policy,
      [],
    );
    return { exitCode, stdout: io.stdout() };
  }

  test("bare `agentcore --json` prints help rather than opening the TUI", async () => {
    const result = await runRoot([]);
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("harness");
  });

  test("`agentcore harness --json` prints the harness command's help", async () => {
    const result = await runRoot(["harness"]);
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage:");
    // The harness subcommands are listed in its help.
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("get");
  });

  test("bare-group JSON help holds invocation quiescence through callback and drain", async () => {
    const accepted = deferred();
    let completeWrite: ((error?: Error | null) => void) | undefined;
    let stdoutText = "";
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        completeWrite = callback;
        accepted.resolve();
      },
    });
    const stderr = captureStream();
    const baseSupervisor = createStreamSupervisor(
      stdout as unknown as NodeJS.WriteStream,
      stderr.stream,
    );
    const quiesceStarted = deferred();
    let capturedQuiescence: Promise<void> | undefined;
    const supervisor: StreamSupervisor = {
      stdout: baseSupervisor.stdout,
      stderr: baseSupervisor.stderr,
      quiesce: () => {
        capturedQuiescence = baseSupervisor.quiesce();
        quiesceStarted.resolve();
        return capturedQuiescence;
      },
      dispose: () => {
        baseSupervisor.dispose();
      },
    };
    const policy = createInvocationExecutionPolicy(supervisor);
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const root = createRootHandler(new TestCoreClient(), {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr.stream,
    });

    const running = runWithExitCode(
      async () => {
        await root.route(["node", "agentcore", "--json"], policy.commander);
      },
      policy,
      [],
    );
    await accepted.promise;
    await quiesceStarted.promise;
    const heldAtHighWater = !(await settledAfterMicrotasks(capturedQuiescence!));

    completeWrite?.();
    const exitCode = await running;

    expect(heldAtHighWater).toBe(true);
    expect(exitCode).toBe(ExitCode.SUCCESS);
    expect(stdoutText).toContain("Usage: agentcore");
    expect(stderr.read()).toBe("");
  });

  test("bare-group JSON help output failure affects eventual exit status", async () => {
    const stdout = new FailingWritable();
    const stderr = captureStream();
    const supervisor = createStreamSupervisor(stdout.asWriteStream(), stderr.stream);
    const policy = createInvocationExecutionPolicy(supervisor);
    const root = createRootHandler(new TestCoreClient(), {
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: stdout.asWriteStream(),
      stderr: stderr.stream,
    });

    const exitCode = await runWithExitCode(
      async () => {
        await root.route(["node", "agentcore", "--json"], policy.commander);
      },
      policy,
      [],
    );

    expect(exitCode).toBe(ExitCode.FAILURE);
    expect(stderr.read()).toBe("Command output could not be written.\n");
    expect(`${stdout.writes.join("")}${stderr.read()}`).not.toContain("stdout failure sentinel");
  });
});
