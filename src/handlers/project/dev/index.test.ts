import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { HttpRequestHandler, PortChecker } from "../../../io";
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
      if (input.signal.aborted) return;
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
    traces: { list: async () => [], get: async () => undefined },
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
  tty?: boolean;
  reloadedRuntimes?: ProjectRuntime[];
  codeZip?: ReturnType<typeof captureRunner>;
  container?: ReturnType<typeof captureRunner>;
  checkPort?: PortChecker;
  json?: boolean;
  loadEnvironment?: DevProjectHandlerConfig["loadDevEnvironment"];
};

function harness(options: HarnessOptions = {}) {
  const io = testIO();
  const ui = { starts: [] as { port?: number }[], opened: [] as string[], closed: 0 };
  const watchers: { path: string; onChange: () => void }[] = [];
  let capturedHandler: HttpRequestHandler | undefined;
  const codeZip = options.codeZip ?? captureRunner();
  const container = options.container ?? captureRunner();
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
    startServer: async (requestHandler, serverOptions) => {
      capturedHandler = requestHandler;
      ui.starts.push({ port: serverOptions?.port });
      return {
        port: serverOptions?.port ?? 8081,
        close: async () => {
          ui.closed++;
        },
      };
    },
    openBrowser: async (url) => {
      ui.opened.push(url);
    },
    inspectorAssets: { read: async () => undefined },
    isInteractive: () => options.tty ?? false,
    watchFile: (path, onChange) => {
      watchers.push({ path, onChange });
    },
    projectManager: {
      resolve: async () =>
        options.reloadedRuntimes ? project(...options.reloadedRuntimes) : undefined,
    },
    waitReady: async () => {
      await Bun.sleep(5);
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
    ui,
    watchers,
    inspectorHandler: () => capturedHandler,
    run: (
      flags: {
        agent?: string;
        port?: number;
        traces?: boolean;
        mode?: "browser" | "headless" | "tui";
        "ui-port"?: number;
      } = {},
    ) => handler.handle(ctx, { traces: true, mode: "headless", ...flags }, {}),
  };
}

/** Ask the captured Inspector handler for the current agent status. */
async function inspectorStatus(subject: ReturnType<typeof harness>): Promise<{ name: string }[]> {
  const response = await subject.inspectorHandler()!({
    method: "GET",
    url: "/api/status",
    headers: { host: "127.0.0.1:8081" },
    body: Buffer.alloc(0),
    signal: new AbortController().signal,
  });
  const status = JSON.parse(String(response.body)) as { agents: { name: string }[] };
  return status.agents;
}

describe("project dev selection and dispatch", () => {
  test.each([
    [project(), {}, "This project has no runtimes", InputValidationError],
    [
      project(runtime("orders"), runtime("support", "Container")),
      { port: 4567 },
      "--port applies to a single runtime. Use --agent to select one.",
      InputValidationError,
    ],
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
    await subject.run({ agent: "support", port: 4567 });

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
  });

  test("announces an automatically selected port", async () => {
    const checked: number[] = [];
    const subject = harness({
      checkPort: async (port) => {
        checked.push(port);
        return port === 8081;
      },
    });
    await subject.run({ agent: "orders" });

    expect(checked).toEqual([8080, 8081]);
    expect(subject.codeZip.inputs[0]?.port).toBe(8081);
    expect(subject.io.stderr()).toContain("Port 8080 is in use; using 8081.");
  });
});

describe("project dev headless multi-agent", () => {
  const twoRuntimes = () => project(runtime("orders"), runtime("support", "Container"));

  /** Start a headless multi-agent run and give its agents time to reach "running". */
  async function supervised(subject: ReturnType<typeof harness>) {
    const pending = subject.run();
    pending.catch(() => undefined);
    await Bun.sleep(30);
    return { pending };
  }

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

  test("one agent failing to start leaves the others running", async () => {
    const subject = harness({
      project: twoRuntimes(),
      codeZip: captureRunner([{ type: "status", message: "dying" }]),
      container: stayingRunner(),
    });
    const { pending } = await supervised(subject);

    expect(subject.io.stderr()).toContain("[orders] Agent 'orders' failed to start");
    expect(subject.io.stderr()).toContain("Agent 'support' is running on port");

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
  });

  test("exits non-zero when every agent fails to start", async () => {
    const subject = harness({ project: twoRuntimes() });

    await expect(subject.run()).rejects.toBeInstanceOf(SilentCLIError);
    expect(subject.collector.state.closed).toBe(1);
  });
});

describe("project dev trace collection", () => {
  test("starts the collector, announces it, and points a CodeZip agent at loopback", async () => {
    const subject = harness();
    await subject.run({ agent: "orders" });

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
    expect(subject.collector.state.closed).toBe(1);
  });

  test("binds the collector to all interfaces so a container can reach it", async () => {
    const subject = harness({ project: project(runtime("support", "Container")) });
    await subject.run({ agent: "support" });

    expect(subject.collector.starts[0]?.host).toBe("0.0.0.0");
  });

  test("reports a trace-persistence failure once, not per failed export", async () => {
    const subject = harness();
    await subject.run({ agent: "orders" });

    const onError = subject.collector.starts[0]?.onError;
    onError?.(new Error("disk full"));
    onError?.(new Error("disk full"));

    const stderr = subject.io.stderr();
    expect(stderr).toContain("failed to persist traces");
    expect(stderr).toContain("disk full");
    expect(stderr.match(/failed to persist traces/g)).toHaveLength(1);
  });

  test("--no-traces skips the collector entirely", async () => {
    const subject = harness();
    await subject.run({ agent: "orders", traces: false });

    expect(subject.collector.starts).toHaveLength(0);
    expect(subject.codeZip.inputs[0]?.env).toEqual({ FROM_LOADER: "yes" });
  });

  test("a runtime with instrumentation disabled skips the collector", async () => {
    const disabled = { ...runtime(), instrumentation: { enableOtel: false } } as ProjectRuntime;
    const subject = harness({ project: project(disabled) });
    await subject.run({ agent: "orders" });

    expect(subject.collector.starts).toHaveLength(0);
    expect(subject.codeZip.inputs[0]?.env).toEqual({ FROM_LOADER: "yes" });
  });

  test("the collector is closed when the runner fails", async () => {
    const codeZip = captureRunner();
    codeZip.runner.run = async function* () {
      yield* [];
      throw new InputValidationError("runner failed");
    };
    const subject = harness({ codeZip });

    await expect(subject.run({ agent: "orders" })).rejects.toThrow("runner failed");
    expect(subject.collector.state.closed).toBe(1);
  });
});

describe("project dev Inspector UI mode", () => {
  // Wraps the run promise so awaiting this helper does not flatten it into
  // "wait for the whole dev command to exit".
  async function runUi(subject: ReturnType<typeof harness>, flags: Record<string, unknown> = {}) {
    const pending = subject.run({ mode: "browser", ...flags });
    pending.catch(() => undefined);
    await Bun.sleep(5); // let the handler start the UI server and block on events
    return { pending };
  }

  test("starts the Inspector, prints the URL, and opens the browser on a TTY", async () => {
    const subject = harness({ tty: true });
    const { pending } = await runUi(subject);

    expect(subject.ui.starts).toEqual([{ port: 8081 }]);
    expect(subject.io.stderr()).toContain("Agent Inspector running at http://127.0.0.1:8081");
    expect(subject.ui.opened).toEqual(["http://127.0.0.1:8081"]);

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
    expect(subject.collector.state.closed).toBe(1);
  });

  test.each([{}, { tty: true, json: true }] as const)(
    "never opens a browser without a TTY or in JSON mode (%o)",
    async (options) => {
      const subject = harness(options);
      const { pending } = await runUi(subject);
      expect(subject.ui.opened).toEqual([]);
      process.emit("SIGINT", "SIGINT");
      await pending.catch(() => undefined);
    },
  );

  test("serves the Inspector API: status lists every runtime, none started", async () => {
    const subject = harness({
      project: project(runtime("orders"), runtime("support", "Container")),
    });
    const { pending } = await runUi(subject);

    expect((await inspectorStatus(subject)).map((agent) => agent.name)).toEqual([
      "orders",
      "support",
    ]);
    expect(subject.codeZip.inputs).toHaveLength(0);

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
  });

  test("agentcore.json edits reload the supervised agents", async () => {
    const subject = harness({ reloadedRuntimes: [runtime("orders"), runtime("payments")] });
    const { pending } = await runUi(subject);

    expect(subject.watchers[0]?.path).toBe(
      join("/workspace/project", "agentcore", "agentcore.json"),
    );
    subject.watchers[0]!.onChange();
    await Bun.sleep(5);

    expect((await inspectorStatus(subject)).map((agent) => agent.name)).toEqual([
      "orders",
      "payments",
    ]);
    expect(subject.io.stderr()).toContain("Reloaded agents from agentcore.json.");

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
  });

  test("--agent narrows the supervised set", async () => {
    const subject = harness({
      project: project(runtime("orders"), runtime("support", "Container")),
    });
    const { pending } = await runUi(subject, { agent: "support" });

    expect((await inspectorStatus(subject)).map((agent) => agent.name)).toEqual(["support"]);

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
  });

  test("an explicit --ui-port that is taken fails fast", async () => {
    const subject = harness({ checkPort: async () => false });
    await expect(subject.run({ mode: "browser", "ui-port": 9999 })).rejects.toThrow(
      "Port 9999 is already in use",
    );
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
    await subject.run({ agent: "orders", traces: false });
    expect(subject.io.stdout()).toBe(
      json
        ? events.map((event) => JSON.stringify({ agent: "orders", ...event })).join("\n")
        : "[orders] agent output",
    );
    expect(subject.io.stderr()).toBe(json ? "" : "[orders] Starting\n[orders] agent warning");
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
      const pending = subject.run({ agent: "orders" });
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

  test("preserves an ordinary runner failure", async () => {
    const failure = new InputValidationError("runner failed");
    const codeZip = captureRunner();
    codeZip.runner.run = async function* () {
      yield* [];
      throw failure;
    };

    await expect(harness({ codeZip }).run({ agent: "orders" })).rejects.toBe(failure);
  });
});
