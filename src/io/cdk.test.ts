import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { IIoHost, IoMessage, IoRequest } from "@aws-cdk/toolkit-lib";
// The real toolkit package, so the arguments these tests assert on are the values
// the toolkit itself defines rather than ones the tests made up. Imported statically
// here, unlike in cdk.ts, because a test file pays no startup cost.
import * as toolkit from "@aws-cdk/toolkit-lib";
import type { Stack } from "@aws-sdk/client-cloudformation";
import {
  isBootstrapCurrent,
  readBootstrapStack,
  loadBootstrapTemplate,
  loadCdkToolkit,
  performCdkOperation,
  runCdk,
  streamCdkOperation,
  type CdkEvent,
  type CdkOutputs,
  type CdkToolkit,
  type CdkToolkitLib,
} from "./cdk";

// The toolkit reports far more than these two fields; a run only reads these.
function message(level: string, text: string): IoMessage<unknown> {
  return { level, message: text } as unknown as IoMessage<unknown>;
}

const lib: CdkToolkitLib = toolkit;

// What a compiled executable holds: the toolkit's template, under the name the
// build's asset naming gives it, beside the assets it also embeds.
function embedded(text: string): (Blob & { name: string })[] {
  return [
    new File(["unrelated"], "agentcore-assets/src/assets/cdk/cdk.json"),
    new File([text], "agentcore-assets/lib/api/bootstrap/bootstrap-template.yaml"),
  ];
}

async function collect(generator: AsyncGenerator<CdkEvent, CdkOutputs>): Promise<CdkEvent[]> {
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
        return {};
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
      return {};
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
        return {};
      }),
    );

    expect(answer).toBe(true);
  });

  test("reports nothing for an operation that reports nothing", async () => {
    expect(await collect(streamCdkOperation(async () => ({})))).toEqual([]);
  });

  test("returns what the operation produced once its messages are drained", async () => {
    const generator = streamCdkOperation(async (ioHost) => {
      await ioHost.notify(message("info", "creating"));
      return { RuntimeArn: "arn:example" };
    });

    // The messages are progress; the outputs are the result, so they reach the caller as
    // the generator's return value rather than as one more message to be filtered out.
    expect(await generator.next()).toEqual({
      done: false,
      value: { level: "info", message: "creating" },
    });
    expect(await generator.next()).toEqual({ done: true, value: { RuntimeArn: "arn:example" } });
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
        return { stacks: [{ outputs: { RuntimeArn: "arn:example" } }] };
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

    // Nothing is embedded when running from source, so the toolkit reads its own
    // template rather than one written out for it.
    expect(calls[0]!.args[1]).not.toHaveProperty("source");

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

  test("bootstraps a compiled executable from the template it has embedded", async () => {
    // The released-binary path: no node_modules, so the toolkit cannot find its own
    // template and is handed the embedded copy instead.
    let templateFile: string | undefined;
    let uploaded: string | undefined;
    const toolkit = {
      bootstrap: async (_environments: unknown, options: { source?: { templateFile: string } }) => {
        templateFile = options.source?.templateFile;
        // Read here rather than after: the file lives only for the operation.
        uploaded = await Bun.file(templateFile!).text();
      },
    } as unknown as CdkToolkit;

    await performCdkOperation(
      { lib, toolkit },
      { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] },
      { assemblyDirectory: "/unused", region: "us-east-1" },
      embedded("Resources: {}"),
    );

    expect(uploaded).toBe("Resources: {}");
    // Cleaned up, so a long-lived process bootstrapping repeatedly leaves nothing behind.
    expect(await Bun.file(templateFile!).exists()).toBe(false);
  });

  test("removes the template it wrote out even when bootstrap fails", async () => {
    let templateFile: string | undefined;
    const toolkit = {
      bootstrap: async (_environments: unknown, options: { source?: { templateFile: string } }) => {
        templateFile = options.source?.templateFile;
        throw new Error("bootstrap stack rollback complete");
      },
    } as unknown as CdkToolkit;

    await expect(
      performCdkOperation(
        { lib, toolkit },
        { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] },
        { assemblyDirectory: "/unused", region: "us-east-1" },
        embedded("Resources: {}"),
      ),
    ).rejects.toThrow(/rollback complete/);

    expect(await Bun.file(templateFile!).exists()).toBe(false);
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

  test("returns the outputs of the stack it deployed", async () => {
    const { toolkit } = stubToolkit();

    const outputs = await performCdkOperation(
      { lib, toolkit },
      { kind: "deploy", stackName: "AgentCore-MyAgent-default" },
      { assemblyDirectory: "/tmp/example/cdk.out", region: "us-east-1" },
    );

    // The toolkit is the only thing that knows them, and a caller that never sees them
    // can only tell the user that something was deployed.
    expect(outputs).toEqual({ RuntimeArn: "arn:example" });
  });

  test("returns no outputs for a bootstrap", async () => {
    const { toolkit } = stubToolkit();

    // Bootstrapping deploys the toolkit's own stack, whose outputs are not the user's.
    expect(
      await performCdkOperation(
        { lib, toolkit },
        { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] },
        { assemblyDirectory: "/unused", region: "us-east-1" },
      ),
    ).toEqual({});
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

describe("loadBootstrapTemplate", () => {
  test("writes the embedded template where the toolkit can read it", async () => {
    const path = await loadBootstrapTemplate(embedded("Resources: {}"));

    // A path, not bytes: the toolkit takes a template file to upload.
    expect(path).toBeString();
    expect(await Bun.file(path!).text()).toBe("Resources: {}");
    await rm(dirname(path!), { recursive: true, force: true });
  });

  test("reports no template when nothing is embedded", async () => {
    // Running from source or the bundle, where the toolkit package is a real
    // directory on disk and finds its own template.
    expect(await loadBootstrapTemplate([])).toBeUndefined();
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

describe("readBootstrapStack", () => {
  // What DescribeStacks returns for a bootstrap stack in the given state.
  function described(status: Stack["StackStatus"], version?: string): Stack[] {
    return [
      {
        StackName: "CDKToolkit",
        CreationTime: new Date(0),
        StackStatus: status,
        Outputs: [
          { OutputKey: "BucketName", OutputValue: "cdk-hnb659fds-assets-111122223333-us-east-1" },
          ...(version ? [{ OutputKey: "BootstrapVersion", OutputValue: version }] : []),
        ],
      },
    ];
  }

  test("reads the version a healthy bootstrap stack reports", () => {
    expect(readBootstrapStack(described("CREATE_COMPLETE", "32"))).toEqual({
      version: 32,
      usable: true,
    });
    // Bootstrapping over a stack that had rolled back leaves it here, and it works.
    expect(readBootstrapStack(described("UPDATE_ROLLBACK_COMPLETE", "30"))).toEqual({
      version: 30,
      usable: true,
    });
  });

  test("reads a stack that is not in a state to deploy against as unusable", () => {
    // The version output says what the stack was meant to be; these say whether the roles
    // and bucket a deploy needs are actually there.
    expect(readBootstrapStack(described("ROLLBACK_COMPLETE", "32")).usable).toBe(false);
    expect(readBootstrapStack(described("DELETE_IN_PROGRESS", "32")).usable).toBe(false);
    expect(readBootstrapStack(described("UPDATE_ROLLBACK_FAILED", "32")).usable).toBe(false);
  });

  test("reads a missing or unparseable version as none at all", () => {
    // Rather than NaN, which would compare false against every threshold silently.
    expect(readBootstrapStack(described("CREATE_COMPLETE"))).toEqual({ version: 0, usable: true });
    expect(readBootstrapStack(described("CREATE_COMPLETE", "v32")).version).toBe(0);
  });

  test("reads an empty response as no bootstrap stack", () => {
    expect(readBootstrapStack([])).toEqual({ version: 0, usable: false });
    expect(readBootstrapStack()).toEqual({ version: 0, usable: false });
  });
});

describe("isBootstrapCurrent", () => {
  // A probe answer, as DescribeStacks would have produced it.
  const stack =
    (version: number, usable = true) =>
    async () => ({ version, usable });

  test("is current for a bootstrap new enough to deploy against", async () => {
    expect(await isBootstrapCurrent("us-east-1", stack(30))).toBe(true);
    expect(await isBootstrapCurrent("us-east-1", stack(99))).toBe(true);
  });

  test("is not current for a bootstrap older than we deploy against", async () => {
    // An old bootstrap is bootstrapped again, which is what upgrades it.
    expect(await isBootstrapCurrent("us-east-1", stack(29))).toBe(false);
    expect(await isBootstrapCurrent("us-east-1", stack(0))).toBe(false);
  });

  test("is not current for a new enough bootstrap that is not in a usable state", async () => {
    // Deploying against a rolled-back or half-deleted CDKToolkit fails confusingly; it is
    // bootstrapped again instead, which is what repairs it.
    expect(await isBootstrapCurrent("us-east-1", stack(32, false))).toBe(false);
  });

  test("is not current when the stack cannot be read", async () => {
    // No such stack, or no permission to look: bootstrap runs and reports the real
    // problem, rather than the probe guessing at it.
    const unreadable = async () => {
      throw new Error("AccessDenied");
    };
    expect(await isBootstrapCurrent("us-east-1", unreadable)).toBe(false);
  });
});
