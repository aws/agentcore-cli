import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { PortChecker } from "../../../io";
import { ProjectKey, ValueContext } from "../../../router";
import { testIO } from "../../../testing";
import { JsonRendererKey } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project } from "../types";
import { createDevProjectHandler, type DevProjectHandlerConfig } from ".";
import type { DevEnvironmentInput } from "./environment";
import type { DevEvent, DevRunner, DevServerInput, DevTraceCollector } from "./types";

function runtime(name = "orders", build: ProjectRuntime["build"] = "CodeZip"): ProjectRuntime {
  return {
    name,
    build,
    protocol: "HTTP",
    entrypoint: "main.py",
    codeLocation: `app/${name}`,
  } as ProjectRuntime;
}

function project(...runtimes: ProjectRuntime[]): Project {
  return {
    name: "test-project",
    rootPath: "/workspace/project",
    spec: { runtimes } as Project["spec"],
  };
}

/** A runner that emits `events` then exits, so the supervisor marks it failed to start. */
function captureRunner(events: DevEvent[] = []) {
  const inputs: DevServerInput[] = [];
  const runner: DevRunner = {
    run: async function* (input) {
      inputs.push(input);
      yield* events;
    },
  };
  return { runner, inputs };
}

/** A runner that emits `events` then stays alive until aborted, like a real dev server. */
function stayingRunner(events: DevEvent[] = []) {
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

function fakeCollector() {
  const starts: Parameters<DevProjectHandlerConfig["startTraceCollector"]>[0][] = [];
  const state = { closed: 0 };
  const collector: DevTraceCollector = {
    port: 43180,
    envVars: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43180",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:43180/v1/traces",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    },
    close: async () => {
      state.closed++;
    },
  };
  const start: DevProjectHandlerConfig["startTraceCollector"] = async (options) => {
    starts.push(options);
    return collector;
  };
  return { start, starts, state };
}

type HarnessOptions = {
  project?: Project;
  codeZip?: ReturnType<typeof captureRunner>;
  container?: ReturnType<typeof captureRunner>;
  checkPort?: PortChecker;
  json?: boolean;
  loadEnvironment?: DevProjectHandlerConfig["loadDevEnvironment"];
};

function harness(options: HarnessOptions = {}) {
  const io = testIO();
  const codeZip = options.codeZip ?? stayingRunner();
  const container = options.container ?? stayingRunner();
  const collector = fakeCollector();
  const environmentInputs: DevEnvironmentInput[] = [];
  const handler = createDevProjectHandler({
    io: io.io,
    runners: { CodeZip: codeZip.runner, Container: container.runner },
    loadDevEnvironment:
      options.loadEnvironment ??
      (async (input) => {
        environmentInputs.push(input);
        return { env: { FROM_LOADER: "yes" } };
      }),
    checkPort: options.checkPort ?? (async () => true),
    startTraceCollector: collector.start,
    // A staying agent is ready after this delay; one that exits sooner loses the
    // race and is reported failed, so tests never bind a real port.
    waitReady: async () => {
      await Bun.sleep(20);
    },
  });
  const ctx = ValueContext.EmptyContext()
    .withValue(ProjectKey, options.project ?? project(runtime()))
    .withValue(JsonKey, options.json ?? false)
    .withValue(RegionKey, "us-west-2")
    .withValue(JsonRendererKey, {
      renderJson: (data) => io.io.stdout.write(`${JSON.stringify(data, null, 2)}\n`),
      renderJsonLine: (data) => io.io.stdout.write(`${JSON.stringify(data)}\n`),
    });

  return {
    codeZip,
    container,
    collector,
    environmentInputs,
    io,
    run: (flags: { agent?: string; port?: number; traces?: boolean } = {}) =>
      handler.handle(ctx, { traces: true, ...flags }, {}),
  };
}

/**
 * Start a supervised run and let its agents reach "running". Returns the pending
 * promise wrapped, so awaiting this helper does not flatten into the run itself.
 */
async function supervised(
  subject: ReturnType<typeof harness>,
  flags = {},
): Promise<{ pending: Promise<void> }> {
  const pending = subject.run(flags);
  pending.catch(() => undefined);
  await Bun.sleep(50);
  return { pending };
}

async function interrupt(pending: Promise<unknown>): Promise<void> {
  process.emit("SIGINT", "SIGINT");
  await pending.catch(() => undefined);
}

describe("project dev selection and dispatch", () => {
  test.each([
    [project(), {}, "This project has no runtimes", InputValidationError],
    [
      project(runtime("orders"), runtime("support", "Container")),
      { agent: "missing" },
      "Runtime 'missing' was not found. Available runtimes: orders, support",
      ResourceNotFoundError,
    ],
  ] as const)(
    "rejects invalid runtime selection",
    async (configuredProject, flags, message, ErrorType) => {
      const pending = harness({ project: configuredProject }).run(flags);
      await expect(pending).rejects.toBeInstanceOf(ErrorType);
      await expect(pending).rejects.toThrow(message);
    },
  );

  test("loads the environment and dispatches the selected runtime", async () => {
    const subject = harness({
      project: project(runtime("orders"), runtime("support", "Container")),
    });
    const { pending } = await supervised(subject, { agent: "support", port: 4567 });

    expect(subject.codeZip.inputs).toHaveLength(0);
    expect(subject.environmentInputs).toEqual([
      {
        projectRoot: "/workspace/project",
        runtime: expect.objectContaining({ name: "support" }),
        region: "us-west-2",
      },
    ]);
    expect(subject.container.inputs[0]).toMatchObject({
      projectRoot: "/workspace/project",
      port: 4567,
      env: {
        FROM_LOADER: "yes",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:43180",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://host.docker.internal:43180/v1/traces",
        OTEL_SERVICE_NAME: "support",
      },
      runtime: { name: "support", build: "Container" },
    });
    await interrupt(pending);
  });

  test("resolves and announces an automatically selected port", async () => {
    const checked: number[] = [];
    const subject = harness({
      checkPort: async (port) => {
        checked.push(port);
        return port === 8081;
      },
    });
    const { pending } = await supervised(subject);

    expect(checked).toEqual([8080, 8081]);
    expect(subject.codeZip.inputs[0]?.port).toBe(8081);
    expect(subject.io.stderr()).toContain("Agent 'orders' is running on port 8081");
    await interrupt(pending);
  });
});

describe("project dev multi-agent supervision", () => {
  const twoRuntimes = () => project(runtime("orders"), runtime("support", "Container"));

  test("supervises every runtime with attributed output and per-runtime env", async () => {
    const codeZip = stayingRunner([{ type: "stdout", line: "orders says hi" }]);
    const container = stayingRunner();
    const subject = harness({ project: twoRuntimes(), codeZip, container });
    const { pending } = await supervised(subject);

    expect(codeZip.inputs).toHaveLength(1);
    expect(container.inputs).toHaveLength(1);
    expect(codeZip.inputs[0]!.env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43180",
      OTEL_SERVICE_NAME: "orders",
    });
    expect(container.inputs[0]!.env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:43180",
      OTEL_SERVICE_NAME: "support",
    });
    expect(subject.io.stdout()).toContain("[orders] orders says hi");
    expect(subject.io.stderr()).toContain("Agent 'orders' is running on port");

    process.emit("SIGINT", "SIGINT");
    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    expect(subject.collector.state.closed).toBe(1);
  });

  test("one agent failing to start does not stop the others", async () => {
    const subject = harness({
      project: twoRuntimes(),
      codeZip: captureRunner([{ type: "status", message: "dying" }]), // exits: never ready
      container: stayingRunner(),
    });
    const { pending } = await supervised(subject);

    expect(subject.io.stderr()).toContain("[orders] Agent 'orders' failed to start");
    expect(subject.io.stderr()).toContain("Agent 'support' is running on port");
    await interrupt(pending);
  });

  test("--port without --agent is rejected when several runtimes exist", async () => {
    await expect(harness({ project: twoRuntimes() }).run({ port: 4567 })).rejects.toThrow(
      "--port applies to a single runtime",
    );
  });
});

describe("project dev trace collection", () => {
  test("starts the collector, announces it, and points a CodeZip agent at loopback", async () => {
    const subject = harness();
    const { pending } = await supervised(subject);

    expect(subject.collector.starts).toEqual([
      {
        tracesDirectory: join("/workspace/project", "agentcore", ".cli", "traces", "otlp"),
        host: "127.0.0.1",
        onError: expect.any(Function),
      },
    ]);
    expect(subject.io.stderr()).toContain("OTEL collector listening on port 43180");
    expect(subject.codeZip.inputs[0]?.env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43180",
      OTEL_SERVICE_NAME: "orders",
    });
    await interrupt(pending);
    expect(subject.collector.state.closed).toBe(1);
  });

  test("binds the collector to all interfaces so a container can reach it", async () => {
    const subject = harness({ project: project(runtime("support", "Container")) });
    const { pending } = await supervised(subject);

    expect(subject.collector.starts[0]?.host).toBe("0.0.0.0");
    await interrupt(pending);
  });

  test("reports a trace-persistence failure once, not per failed export", async () => {
    const subject = harness();
    const { pending } = await supervised(subject);

    const onError = subject.collector.starts[0]?.onError;
    onError?.(new Error("disk full"));
    onError?.(new Error("disk full"));

    const stderr = subject.io.stderr();
    expect(stderr).toContain("failed to persist traces");
    expect(stderr).toContain("disk full");
    expect(stderr.match(/failed to persist traces/g)).toHaveLength(1);
    await interrupt(pending);
  });

  test("--no-traces skips the collector entirely", async () => {
    const subject = harness();
    const { pending } = await supervised(subject, { traces: false });

    expect(subject.collector.starts).toHaveLength(0);
    expect(subject.codeZip.inputs[0]?.env).toEqual({ FROM_LOADER: "yes" });
    await interrupt(pending);
  });

  test("a runtime with instrumentation disabled skips the collector", async () => {
    const disabled = { ...runtime(), instrumentation: { enableOtel: false } } as ProjectRuntime;
    const subject = harness({ project: project(disabled) });
    const { pending } = await supervised(subject);

    expect(subject.collector.starts).toHaveLength(0);
    expect(subject.codeZip.inputs[0]?.env).toEqual({ FROM_LOADER: "yes" });
    await interrupt(pending);
  });

  test("a failed agent exits non-zero and still closes the collector", async () => {
    const codeZip = captureRunner();
    codeZip.runner.run = async function* () {
      yield* [];
      throw new InputValidationError("runner failed");
    };
    const subject = harness({ codeZip });

    await expect(subject.run()).rejects.toBeInstanceOf(SilentCLIError);
    expect(subject.collector.state.closed).toBe(1);
  });
});

test("project dev renders attributed human and NDJSON output", async () => {
  const events: DevEvent[] = [
    { type: "status", message: "Starting" },
    { type: "stdout", line: "agent output" },
    { type: "stderr", line: "agent warning" },
  ];

  for (const json of [false, true]) {
    const subject = harness({ codeZip: captureRunner(events), json });
    await subject.run({ traces: false }).catch(() => undefined);
    if (json) {
      expect(subject.io.stdout()).toContain(
        JSON.stringify({ agent: "orders", type: "stdout", line: "agent output" }),
      );
    } else {
      expect(subject.io.stdout()).toContain("[orders] agent output");
      expect(subject.io.stderr()).toContain("[orders] Starting");
      expect(subject.io.stderr()).toContain("[orders] agent warning");
    }
  }
});

function heldRunner() {
  let start!: (input: DevServerInput) => void;
  let release: (() => void) | undefined;
  const started = new Promise<DevServerInput>((resolve) => (start = resolve));
  const runner: DevRunner = {
    run: async function* (input) {
      yield* [];
      start(input);
      await new Promise<void>((resolve) => (release = resolve));
      input.signal.throwIfAborted();
    },
  };
  return { runner, inputs: [], started, release: () => release?.() };
}

describe("project dev interruption", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s aborts, reports exit 130, and removes its listener",
    async (signal) => {
      const codeZip = heldRunner();
      const before = process.listenerCount(signal);
      const subject = harness({ codeZip });
      const pending = subject.run();
      const input = await codeZip.started;

      process.emit(signal, signal);
      process.emit(signal, signal);
      codeZip.release();

      expect(input.signal.aborted).toBe(true);
      expect(input.signal.reason).toBeInstanceOf(UserCancellationError);
      await expect(pending).rejects.toBe(input.signal.reason);
      expect((input.signal.reason as UserCancellationError).exitCode).toBe(130);
      // Traces are on by default, so the collector's "listening" line precedes this.
      expect(subject.io.stderr()).toContain("Shutting down…");
      expect(subject.collector.state.closed).toBe(1);
      expect(process.listenerCount(signal)).toBe(before);
    },
  );
});
