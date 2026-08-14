import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IIoHost, IoMessage, IoRequest } from "@aws-cdk/toolkit-lib";
// The real toolkit package, so the arguments these tests assert on are the values
// the toolkit itself defines rather than ones the tests made up. Imported statically
// here, unlike in cdk.ts, because a test file pays no startup cost.
import * as toolkit from "@aws-cdk/toolkit-lib";
import {
  loadCdkToolkit,
  performCdkOperation,
  runCdk,
  streamCdkOperation,
  type CdkEvent,
  type CdkToolkit,
  type CdkToolkitLib,
} from "./cdk";

// The toolkit reports far more than these two fields; a run only reads these.
function message(level: string, text: string): IoMessage<unknown> {
  return { level, message: text } as unknown as IoMessage<unknown>;
}

const lib: CdkToolkitLib = toolkit;

async function collect(generator: AsyncGenerator<CdkEvent, void>): Promise<CdkEvent[]> {
  const events: CdkEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("streamCdkOperation", () => {
  test("yields the messages the operation reports, in order", async () => {
    const events = await collect(
      streamCdkOperation(async (ioHost) => {
        await ioHost.notify(message("info", "first"));
        await ioHost.notify(message("warn", "second"));
      }),
    );

    expect(events).toEqual([
      { level: "info", message: "first" },
      { level: "warn", message: "second" },
    ]);
  });

  test("yields each message while the operation is still running", async () => {
    // The point of the generator: a deploy runs for minutes, so the caller must see
    // a message before the operation that produced it finishes. Reaching the second
    // notify at all proves the first was consumed while the operation was awaiting.
    let released = false;
    const generator = streamCdkOperation(async (ioHost) => {
      await ioHost.notify(message("info", "creating"));
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      released = true;
      await ioHost.notify(message("info", "created"));
    });

    const first = await generator.next();
    expect(first.value).toEqual({ level: "info", message: "creating" });
    // Delivered before the operation reached its second half, not buffered until the end.
    expect(released).toBe(false);

    expect(await collect(generator)).toEqual([{ level: "info", message: "created" }]);
  });

  test("throws the operation's failure only after draining the messages that explain it", async () => {
    const generator = streamCdkOperation(async (ioHost) => {
      await ioHost.notify(message("error", "example-stack | CREATE_FAILED"));
      throw new Error("stack rollback complete");
    });

    // The explanatory output arrives first...
    expect(await generator.next()).toEqual({
      done: false,
      value: { level: "error", message: "example-stack | CREATE_FAILED" },
    });
    // ...and the failure surfaces only once there is nothing left to read.
    await expect(generator.next()).rejects.toThrow(/stack rollback complete/);
  });

  test("answers requests with the toolkit's own suggested default", async () => {
    // Approval must never block on a prompt: there is no guaranteed TTY, so a
    // request has to be answered without one.
    let answer: unknown;
    await collect(
      streamCdkOperation(async (ioHost) => {
        answer = await ioHost.requestResponse({
          defaultResponse: true,
        } as unknown as IoRequest<unknown, boolean>);
      }),
    );

    expect(answer).toBe(true);
  });

  test("reports nothing for an operation that reports nothing", async () => {
    expect(await collect(streamCdkOperation(async () => {}))).toEqual([]);
  });
});

describe("performCdkOperation", () => {
  // Records what a run asks the toolkit to do, without doing it.
  function stubToolkit() {
    const calls: { method: string; args: unknown[] }[] = [];
    const toolkit = {
      bootstrap: async (...args: unknown[]) => {
        calls.push({ method: "bootstrap", args });
      },
      fromAssemblyDirectory: async (...args: unknown[]) => {
        calls.push({ method: "fromAssemblyDirectory", args });
        return { produce: undefined };
      },
      deploy: async (...args: unknown[]) => {
        calls.push({ method: "deploy", args });
      },
    } as unknown as CdkToolkit;
    return { toolkit, calls };
  }

  test("bootstraps the environments with a customer-managed key", async () => {
    const { toolkit, calls } = stubToolkit();

    await performCdkOperation(
      { lib, toolkit },
      { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] },
      { assemblyDirectory: "/unused", region: "us-east-1" },
    );

    expect(calls.map(({ method }) => method)).toEqual(["bootstrap"]);
    const [environments, options] = calls[0]!.args as [
      { getEnvironments: () => Promise<{ name: string; account: string; region: string }[]> },
      { parameters: { parameters: Record<string, unknown> } },
    ];
    expect(await environments.getEnvironments()).toEqual([
      { name: "aws://111122223333/us-east-1", account: "111122223333", region: "us-east-1" },
    ]);
    // The parameter the original CLI bootstraps with. Dropping it would silently
    // change what a default deploy provisions, so it is asserted rather than assumed.
    expect(options.parameters.parameters).toEqual({ createCustomerMasterKey: true });
  });

  test("deploys only the named stack, from the assembly build synthesized", async () => {
    const { toolkit, calls } = stubToolkit();

    await performCdkOperation(
      { lib, toolkit },
      { kind: "deploy", stackName: "AgentCore-MyAgent-default" },
      { assemblyDirectory: "/tmp/example/cdk.out", region: "us-east-1" },
    );

    expect(calls.map(({ method }) => method)).toEqual(["fromAssemblyDirectory", "deploy"]);
    // Reads the directory build wrote rather than re-synthesizing.
    expect(calls[0]!.args[0]).toBe("/tmp/example/cdk.out");
    const [, deployOptions] = calls[1]!.args as [unknown, { stacks: unknown }];
    // MUST_MATCH, so a stack the assembly does not contain fails loudly instead of
    // deploying nothing and reporting success.
    expect(deployOptions.stacks).toEqual({
      strategy: lib.StackSelectionStrategy.PATTERN_MUST_MATCH,
      patterns: ["AgentCore-MyAgent-default"],
    });
  });

  test("does not bootstrap while deploying", async () => {
    const { toolkit, calls } = stubToolkit();

    await performCdkOperation(
      { lib, toolkit },
      { kind: "deploy", stackName: "AgentCore-MyAgent-default" },
      { assemblyDirectory: "/tmp/example/cdk.out", region: "us-east-1" },
    );

    expect(calls.map(({ method }) => method)).not.toContain("bootstrap");
  });
});

describe("loadCdkToolkit", () => {
  test("builds a toolkit without needing credentials", async () => {
    // Constructing the toolkit resolves no credentials and calls no API, which is
    // what lets the rest of these tests run offline.
    const ioHost: IIoHost = {
      notify: async () => {},
      requestResponse: async (request) => request.defaultResponse,
    };

    const { lib, toolkit } = await loadCdkToolkit(ioHost, "us-west-2");

    expect(typeof toolkit.deploy).toBe("function");
    expect(typeof toolkit.bootstrap).toBe("function");
    // The lazily loaded module has to carry the helpers an operation calls, since
    // a missing one would only surface at deploy time rather than at import time.
    expect(typeof lib.BootstrapEnvironments.fromList).toBe("function");
    expect(typeof lib.BootstrapStackParameters.withExisting).toBe("function");
    expect(lib.StackSelectionStrategy.PATTERN_MUST_MATCH).toBeTruthy();
  });
});

describe("runCdk", () => {
  test("reports the toolkit's failure for an assembly directory that holds no assembly", async () => {
    // The one path through the real toolkit that fails before it needs AWS, so the
    // glue between loading, performing, and streaming is exercised end to end.
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-"));
    try {
      const generator = runCdk(
        { kind: "deploy", stackName: "AgentCore-MyAgent-default" },
        { assemblyDirectory: join(directory, "cdk.out"), region: "us-west-2" },
      );

      await expect(collect(generator)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
