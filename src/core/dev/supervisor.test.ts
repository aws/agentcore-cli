import { describe, expect, test } from "bun:test";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { DevSupervisor, waitForPort, type SupervisedEvent } from "./supervisor";
import { createServer } from "node:net";

function runtime(name: string, build: ProjectRuntime["build"] = "CodeZip"): ProjectRuntime {
  return {
    name,
    build,
    protocol: "HTTP",
    entrypoint: "main.py",
    codeLocation: `app/${name}`,
  } as ProjectRuntime;
}

/** A runner that emits `events`, then stays alive until its signal aborts (like a real server). */
function serverRunner(events: DevEvent[] = []) {
  const inputs: DevServerInput[] = [];
  const runner: DevRunner = {
    run: async function* (input) {
      inputs.push(input);
      yield* events;
      await new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  return { runner, inputs };
}

/** A runner whose process dies immediately (optionally with an error). */
function dyingRunner(failure?: Error) {
  const runner: DevRunner = {
    run: async function* () {
      yield { type: "status", message: "starting" };
      if (failure) throw failure;
    },
  };
  return { runner };
}

/** A runner that stays alive and emits events on demand via `emit`, until its signal aborts. */
function pushableRunner() {
  const buffer: DevEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const runner: DevRunner = {
    run: async function* (input) {
      input.signal.addEventListener(
        "abort",
        () => {
          done = true;
          wake?.();
        },
        { once: true },
      );
      while (!done) {
        while (buffer.length) yield buffer.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  const emit = (event: DevEvent) => {
    buffer.push(event);
    wake?.();
  };
  return { runner, emit };
}

/** Let a runner emission propagate through the pump into the supervisor queue. */
const flush = () => Bun.sleep(1);

type HarnessOptions = {
  runtimes?: ProjectRuntime[];
  codeZip?: { runner: DevRunner };
  container?: { runner: DevRunner };
  ready?: (port: number, signal: AbortSignal) => Promise<void>;
};

function harness(options: HarnessOptions = {}) {
  const controller = new AbortController();
  const codeZip = options.codeZip ?? serverRunner();
  const container = options.container ?? serverRunner();
  let nextPort = 9100;
  const supervisor = new DevSupervisor({
    runtimes: options.runtimes ?? [runtime("orders"), runtime("billing", "Container")],
    projectRoot: "/workspace/project",
    runners: { CodeZip: codeZip.runner, Container: container.runner },
    environment: async (agentRuntime) => ({ AGENT: agentRuntime.name }),
    resolvePort: async () => nextPort++,
    waitReady: options.ready ?? (async () => {}),
    signal: controller.signal,
  });
  return { supervisor, controller, codeZip, container };
}

async function drain(
  supervisor: DevSupervisor,
  controller: AbortController,
): Promise<SupervisedEvent[]> {
  controller.abort();
  const collected: SupervisedEvent[] = [];
  for await (const event of supervisor.events()) collected.push(event);
  return collected;
}

describe("DevSupervisor", () => {
  test("agents are idle until started, then report running with their port", async () => {
    const { supervisor, controller } = harness();
    expect(supervisor.snapshot()).toMatchObject([
      { name: "orders", phase: "idle", buildType: "CodeZip", protocol: "HTTP" },
      { name: "billing", phase: "idle", buildType: "Container" },
    ]);

    const started = await supervisor.start("orders");
    expect(started).toEqual({ name: "orders", port: 9100 });
    expect(supervisor.snapshot()[0]).toMatchObject({
      name: "orders",
      phase: "running",
      port: 9100,
    });
    expect(supervisor.running("orders")).toEqual({ port: 9100, protocol: "HTTP" });
    expect(supervisor.running("billing")).toBeUndefined();
    controller.abort();
  });

  test("passes environment, project root, and port to the runner", async () => {
    const codeZip = serverRunner();
    const { supervisor, controller } = harness({ codeZip });
    await supervisor.start("orders");

    expect(codeZip.inputs[0]).toMatchObject({
      projectRoot: "/workspace/project",
      port: 9100,
      env: { AGENT: "orders" },
      runtime: { name: "orders" },
    });
    controller.abort();
  });

  test("concurrent starts of the same agent share one attempt", async () => {
    const codeZip = serverRunner();
    let readiness!: () => void;
    const { supervisor, controller } = harness({
      codeZip,
      ready: () => new Promise((resolve) => (readiness = resolve)),
    });

    const [first, second] = [supervisor.start("orders"), supervisor.start("orders")];
    expect(supervisor.snapshot()[0]!.phase).toBe("starting");
    await Bun.sleep(1); // let the launch reach its readiness wait
    readiness();
    expect(await first).toEqual(await second);
    expect(codeZip.inputs).toHaveLength(1);

    // A start after running returns the existing port without a new attempt.
    expect(await supervisor.start("orders")).toEqual({ name: "orders", port: 9100 });
    expect(codeZip.inputs).toHaveLength(1);
    controller.abort();
  });

  test("an agent that exits before readiness fails the start and can be retried", async () => {
    const { supervisor, controller } = harness({
      codeZip: dyingRunner(new Error("boom")),
      ready: () => new Promise(() => {}),
    });

    expect(supervisor.start("orders")).rejects.toThrow("boom");
    await supervisor.start("orders").catch(() => {});
    expect(supervisor.snapshot()[0]).toMatchObject({
      name: "orders",
      phase: "failed",
      error: "boom",
    });

    // Retry hits the runner again rather than being stuck.
    await supervisor.start("orders").catch(() => {});
    controller.abort();
  });

  test("unknown agents are rejected with the available names", () => {
    const { supervisor, controller } = harness();
    expect(() => supervisor.start("missing")).toThrow("Available agents: orders, billing");
    controller.abort();
  });

  test("merges attributed events from several agents into one stream", async () => {
    const codeZip = serverRunner([{ type: "stdout", line: "orders out" }]);
    const container = serverRunner([{ type: "stderr", line: "billing err" }]);
    const { supervisor, controller } = harness({ codeZip, container });

    await supervisor.start("orders");
    await supervisor.start("billing");
    const events = await drain(supervisor, controller);

    expect(events).toContainEqual({
      agent: "orders",
      event: { type: "stdout", line: "orders out" },
    });
    expect(events).toContainEqual({
      agent: "billing",
      event: { type: "stderr", line: "billing err" },
    });
    expect(events).toContainEqual({
      agent: "orders",
      event: { type: "status", message: "Agent 'orders' is running on port 9100." },
    });
  });

  test("delivers an event queued while the consumer is draining a batch", async () => {
    const orders = pushableRunner();
    const { supervisor, controller } = harness({
      runtimes: [runtime("orders")],
      codeZip: { runner: orders.runner },
    });
    const events = supervisor.events();
    await supervisor.start("orders");

    orders.emit({ type: "stdout", line: "one" });
    await flush();
    // Park the generator mid-batch (at a yield, so `wake` is unset), then queue
    // another event into that window. A lost-wakeup would strand it.
    await events.next();
    orders.emit({ type: "stdout", line: "two" });
    await flush();
    await events.next();

    const next = await Promise.race([events.next(), Bun.sleep(200).then(() => "stalled" as const)]);
    expect(next).not.toBe("stalled");
    expect((next as IteratorResult<SupervisedEvent>).value).toMatchObject({
      agent: "orders",
      event: { type: "stdout", line: "two" },
    });
    controller.abort();
    await events.next();
  });

  test("a running agent that crashes reports failed and leaves the stream alive", async () => {
    let fail!: () => void;
    const crashing: DevRunner = {
      run: async function* () {
        yield { type: "status", message: "up" };
        await new Promise<void>((resolve) => (fail = resolve));
        throw new Error("segfault");
      },
    };
    const { supervisor, controller } = harness({ codeZip: { runner: crashing } });

    await supervisor.start("orders");
    fail();
    await Bun.sleep(5);

    expect(supervisor.snapshot()[0]).toMatchObject({
      name: "orders",
      phase: "failed",
      error: "segfault",
    });
    expect(supervisor.running("orders")).toBeUndefined();
    const events = await drain(supervisor, controller);
    expect(events).toContainEqual({
      agent: "orders",
      event: { type: "status", message: "Agent 'orders' crashed: segfault" },
    });
  });

  test("setRuntimes adds, updates, and drops agents without touching running ones", async () => {
    const { supervisor, controller } = harness();
    await supervisor.start("orders");

    supervisor.setRuntimes([runtime("orders"), runtime("payments")]);
    expect(supervisor.snapshot().map(({ name, phase }) => ({ name, phase }))).toEqual([
      { name: "orders", phase: "running" },
      { name: "payments", phase: "idle" },
    ]);

    // A running agent survives removal from the config until it stops.
    supervisor.setRuntimes([runtime("payments")]);
    expect(supervisor.snapshot().map(({ name }) => name)).toEqual(["orders", "payments"]);
    controller.abort();
  });

  test("readiness polling gives up at its deadline instead of blocking forever", async () => {
    const signal = new AbortController().signal;
    // Nothing listens on this port; a bounded poll must reject, not hang.
    await expect(waitForPort(1, signal, 10, 100)).rejects.toThrow(
      "did not accept connections on port 1 within 0.1s",
    );

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await waitForPort(port, signal, 10, 1000); // resolves against a live listener
    server.close();
  });

  test("failed setup does not leak parent abort listeners across retries", async () => {
    const adds: string[] = [];
    const removes: string[] = [];
    const controller = new AbortController();
    const countingSignal = {
      aborted: false,
      addEventListener: (type: string, listener: () => void, options?: unknown) => {
        adds.push(type);
        controller.signal.addEventListener(type as "abort", listener, options as undefined);
      },
      removeEventListener: (type: string, listener: () => void) => {
        removes.push(type);
        controller.signal.removeEventListener(type as "abort", listener);
      },
    } as unknown as AbortSignal;

    const supervisor = new DevSupervisor({
      runtimes: [runtime("orders")],
      projectRoot: "/workspace/project",
      runners: { CodeZip: serverRunner().runner, Container: serverRunner().runner },
      environment: async () => ({}),
      resolvePort: async () => {
        throw new Error("no ports for you");
      },
      waitReady: async () => {},
      signal: countingSignal,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await supervisor.start("orders").catch(() => {});
    }
    // One constructor wake listener stays; every per-launch listener must be removed.
    expect(adds.length - removes.length).toBe(1);
    controller.abort();
  });

  test("aborting the parent signal stops running agents and ends the stream", async () => {
    const codeZip = serverRunner();
    const { supervisor, controller } = harness({ codeZip });
    await supervisor.start("orders");

    const events: SupervisedEvent[] = [];
    const consuming = (async () => {
      for await (const event of supervisor.events()) events.push(event);
    })();
    controller.abort();
    await consuming;

    expect(codeZip.inputs[0]!.signal.aborted).toBe(true);
  });
});
