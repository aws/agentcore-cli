import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  InputValidationError,
  NotImplementedError,
  ResourceNotFoundError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { HarnessDevHostsConfig, HarnessHostEvent } from "../../../core/dev/harness/hosts";
import { AsyncChannel, type HttpRequestHandler, type PortChecker } from "../../../io";
import { ProjectKey, ValueContext } from "../../../router";
import { testIO, waitFor } from "../../../testing";
import { JsonRendererKey } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type { Project } from "../types";
import {
  BMA_POLICY_FILE,
  BMA_TEMPLATE_NAME,
  BMA_TEMPLATE_TAG_KEY,
  BMA_TEMPLATE_TAG_VALUE,
} from "../bma";
import { createDevProjectHandler, type DevProjectHandlerConfig } from ".";
import type { DevEnvironmentInput } from "./environment";
import type {
  DevEvent,
  DevRunner,
  DevServerInput,
  DevTraceCollector,
  HarnessDevAws,
} from "./types";

function runtime(name = "orders", build: ProjectRuntime["build"] = "CodeZip"): ProjectRuntime {
  return {
    name,
    build,
    protocol: "HTTP",
    entrypoint: "main.py",
    codeLocation: `app/${name}`,
  } as ProjectRuntime;
}

function harnessProject(harnesses: string[], ...runtimes: ProjectRuntime[]): Project {
  return {
    name: "test-project",
    rootPath: "/workspace/project",
    spec: {
      runtimes,
      harnesses: harnesses.map((name) => ({ name, path: `app/${name}` })),
    } as Project["spec"],
  };
}

function bmaRuntime(overrides: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    ...runtime("environment", "Container"),
    tags: { [BMA_TEMPLATE_TAG_KEY]: BMA_TEMPLATE_TAG_VALUE },
    additionalPolicies: [BMA_POLICY_FILE],
    ...overrides,
  };
}

function project(...runtimes: ProjectRuntime[]): Project {
  return harnessProject([], ...runtimes);
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

/** A runner that emits `events` then stays alive until aborted, rejecting with the abort reason like the real process runner. */
function stayingRunner(events: DevEvent[] = []) {
  const inputs: DevServerInput[] = [];
  const runner: DevRunner = {
    run: async function* (input) {
      inputs.push(input);
      yield* events;
      if (!input.signal.aborted) {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      throw input.signal.reason;
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
  reloaded?: Project;
  codeZip?: ReturnType<typeof captureRunner>;
  container?: ReturnType<typeof captureRunner>;
  checkPort?: PortChecker;
  json?: boolean;
  loadEnvironment?: DevProjectHandlerConfig["loadDevEnvironment"];
  createHarnessHosts?: DevProjectHandlerConfig["createHarnessHosts"];
};

function harness(options: HarnessOptions = {}) {
  const io = testIO();
  const ui = { starts: [] as { port?: number }[], opened: [] as string[], closed: 0 };
  const watchers: { path: string; onChange: () => void }[] = [];
  const servers: { port?: number; handler: HttpRequestHandler }[] = [];
  const harnessDevAws: Parameters<DevProjectHandlerConfig["harnessDevAws"]>[] = [];
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
      servers.push({ port: serverOptions?.port, handler: requestHandler });
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
      resolve: async () => options.reloaded,
    },
    harnessDevAws: (...args) => {
      harnessDevAws.push(args);
      return {} as HarnessDevAws;
    },
    createHarnessHosts: options.createHarnessHosts,
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
    harnessDevAws,
    inspectorHandler: () => servers.at(-1)?.handler,
    run: (
      flags: {
        agent?: string;
        harness?: string;
        target?: string;
        port?: number;
        traces?: boolean;
        mode?: "browser" | "headless" | "tui";
        "ui-port"?: number;
      } = {},
    ) => handler.handle(ctx, { traces: true, mode: "headless", target: "default", ...flags }, {}),
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
    ["headless", undefined, project(bmaRuntime({ additionalPolicies: undefined }))],
    ["browser", undefined, project(bmaRuntime({ tags: undefined }))],
    [
      "headless",
      "environment",
      project(bmaRuntime({ tags: { [BMA_TEMPLATE_TAG_KEY]: "Custom" } }), runtime()),
    ],
    ["browser", "environment", project(bmaRuntime(), runtime())],
  ] as const)(
    "rejects unsupported BMA selection (%s, %s)",
    async (mode, agent, configuredProject) => {
      const subject = harness({ project: configuredProject });
      const pending = subject.run({ mode, agent });
      await expect(pending).rejects.toBeInstanceOf(NotImplementedError);
      await expect(pending).rejects.toMatchObject({ source: "user", exitCode: 1 });
      await expect(pending).rejects.toThrow(
        `Local dev is not supported for runtime 'environment' (${BMA_TEMPLATE_NAME})`,
      );
      expect(subject.codeZip.inputs).toHaveLength(0);
      expect(subject.container.inputs).toHaveLength(0);
      expect(subject.collector.starts).toHaveLength(0);
      expect(subject.ui.starts).toHaveLength(0);
    },
  );

  test.each([
    [
      project(),
      {},
      "This project has no runtimes or harnesses. Add one and retry.",
      InputValidationError,
    ],
    [
      harnessProject(["h1"]),
      { harness: "nope" },
      "Harness 'nope' was not found. Available harnesses: h1.",
      ResourceNotFoundError,
    ],
    [
      harnessProject(["h1"], runtime("orders")),
      { harness: "h1", agent: "orders" },
      "--agent and --harness cannot be used together.",
      InputValidationError,
    ],
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
    "rejects invalid resource selection",
    async (configuredProject, flags, message, ErrorType) => {
      const pending = harness({ project: configuredProject }).run(flags);
      await expect(pending).rejects.toBeInstanceOf(ErrorType);
      await expect(pending).rejects.toThrow(message);
    },
  );

  test("loads the environment and dispatches the selected runtime", async () => {
    const subject = harness({
      project: project(bmaRuntime(), runtime("orders"), runtime("support", "Container")),
    });
    await subject.run({ agent: "support", port: 4567 });

    expect(subject.codeZip.inputs).toHaveLength(0);
    expect(subject.environmentInputs).toEqual([
      {
        projectRoot: "/workspace/project",
        env: {},
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
    expect(subject.io.stderr()).not.toContain("Skipping runtime");
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

  test("supervises supported runtimes with attributed output and per-runtime env", async () => {
    const codeZip = stayingRunner([{ type: "stdout", line: "orders says hi" }]);
    const container = stayingRunner();
    const subject = harness({
      project: project(
        bmaRuntime({ tags: { [BMA_TEMPLATE_TAG_KEY]: "Custom" } }),
        runtime("orders"),
        runtime("support", "Container"),
      ),
      codeZip,
      container,
    });
    const { pending } = await supervised(subject);

    expect(subject.io.stderr()).toContain("Skipping runtime 'environment'");
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
    expect(subject.io.stderr()).not.toContain("crashed");
    expect(subject.collector.state.closed).toBe(1);
  });

  test("assigns distinct ports to runtimes launched together", async () => {
    const codeZip = stayingRunner();
    const container = stayingRunner();
    const subject = harness({ project: twoRuntimes(), codeZip, container });
    const { pending } = await supervised(subject);

    expect([codeZip.inputs[0]?.port, container.inputs[0]?.port]).toEqual([8080, 8081]);

    process.emit("SIGINT", "SIGINT");
    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
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

  test("serves the Inspector API: status lists supported runtimes, none started", async () => {
    const subject = harness({
      project: project(bmaRuntime(), runtime("orders"), runtime("support", "Container")),
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
    const subject = harness({
      reloaded: project(bmaRuntime({ tags: undefined }), runtime("orders"), runtime("payments")),
    });
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
    expect(subject.io.stderr()).toContain("Reloaded agents and harnesses from agentcore.json.");

    process.emit("SIGINT", "SIGINT");
    await pending.catch(() => undefined);
  });

  test("--agent narrows the supervised set", async () => {
    const subject = harness({
      project: project(bmaRuntime(), runtime("orders"), runtime("support", "Container")),
    });
    const { pending } = await runUi(subject, { agent: "support" });

    expect((await inspectorStatus(subject)).map((agent) => agent.name)).toEqual(["support"]);
    expect(subject.io.stderr()).not.toContain("Skipping runtime");

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
    const subject = harness({
      project: project(bmaRuntime(), runtime()),
      codeZip: captureRunner(events),
      json,
    });
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

describe("project dev harnesses", () => {
  function fakeHosts(failures: { start?: Error; pull?: Error; events?: Error } = {}) {
    const calls: string[] = [];
    const channel = new AsyncChannel<HarnessHostEvent>();
    const configs: HarnessDevHostsConfig[] = [];
    const cleanup = { done: false };
    let eventsFailure = failures.events;
    const create = (config: HarnessDevHostsConfig) => {
      configs.push(config);
      calls.push(`create:${config.harnesses.map(({ name }) => name).join(",")}`);
      const close = () => {
        cleanup.done = true;
        channel.close();
      };
      config.signal.addEventListener("abort", () => setTimeout(close), { once: true });
      return {
        invoke: async () => {
          throw new Error("unused");
        },
        events: async function* () {
          const error = eventsFailure;
          eventsFailure = undefined;
          if (error) throw error;
          yield* channel;
        },
        setHarnesses: (entries: { name: string }[]) => {
          calls.push(`set:${entries.map(({ name }) => name).join(",")}`);
        },
        snapshot: () => [],
        start: async (name: string) => {
          calls.push(`start:${name}`);
          if (failures.start) throw failures.start;
        },
        pullImage: async () => {
          calls.push("pull");
          if (failures.pull) throw failures.pull;
          return "docker" as const;
        },
      };
    };
    return { calls, channel, configs, cleanup, create };
  }

  async function interrupt(pending: Promise<unknown>) {
    process.emit("SIGINT", "SIGINT");
    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
  }

  test("a harness only project serves the endpoint and streams harness output until interrupted", async () => {
    const hosts = fakeHosts();
    const subject = harness({ project: harnessProject(["h1"]), createHarnessHosts: hosts.create });
    const pending = subject.run();

    await waitFor(() => subject.io.stderr().includes("Harness endpoint listening on port 8090."));
    hosts.channel.push({ agentName: "h1", event: { type: "stdout", line: "runtime up" } });
    hosts.channel.push({ event: { type: "status", message: "Image ready (sha256:1)" } });
    await waitFor(() => subject.io.stderr().includes("Image ready (sha256:1)"));
    await interrupt(pending);

    expect(subject.io.stdout()).toContain("[h1] runtime up");
    expect(subject.collector.starts[0]?.host).toBe("0.0.0.0");
    expect(subject.harnessDevAws).toEqual([[harnessProject(["h1"]), "default", "us-west-2"]]);
    expect(hosts.calls).toEqual(["create:h1"]);
  });

  test("hosts get the loader environment with container OTEL and ports above the endpoint", async () => {
    const hosts = fakeHosts();
    const subject = harness({ project: harnessProject(["h1"]), createHarnessHosts: hosts.create });
    const pending = subject.run();
    await waitFor(() => hosts.configs.length > 0);
    const [config] = hosts.configs;

    const env = await config!.environment({
      spec: HarnessSpecSchema.parse({
        name: "h1",
        model: { provider: "bedrock", modelId: "model" },
        environmentVariables: { MODE: "local" },
      }),
    });
    const ports = [
      ...(await Promise.all([config!.hostPort("h1"), config!.hostPort("h2")])),
      await config!.hostPort("h1"),
    ];
    await interrupt(pending);

    expect(subject.environmentInputs).toEqual([
      { projectRoot: "/workspace/project", env: { MODE: "local" }, region: "us-west-2" },
    ]);
    expect(env).toMatchObject({
      FROM_LOADER: "yes",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:43180",
      OTEL_SERVICE_NAME: "h1",
    });
    expect(ports).toEqual([8091, 8092, 8091]);
  });

  const failure = new InputValidationError("unsupported field");
  test.each([
    ["start", { start: failure }, { harness: "h1" }],
    ["events", { events: failure }, {}],
  ] as const)(
    "a failed harness %s fails the command and stops the hosts",
    async (_step, failures, flags) => {
      const hosts = fakeHosts(failures);
      const subject = harness({
        project: harnessProject(["h1"]),
        createHarnessHosts: hosts.create,
      });

      await expect(subject.run(flags)).rejects.toBe(failure);
      expect(hosts.configs[0]!.signal.aborted).toBe(true);
      expect(hosts.cleanup.done).toBe(true);
      expect(subject.collector.state.closed).toBe(1);
    },
  );

  test.each([
    [harnessProject(["h1"]), { port: 9000 }, 9000, undefined],
    [harnessProject(["h1"], runtime()), { harness: "h1", port: 9000 }, 9000, undefined],
    [harnessProject(["h1"], runtime()), { port: 9000 }, 8090, 9000],
  ] as const)(
    "--port follows the selection (%#)",
    async (configuredProject, flags, endpointPort, runtimePort) => {
      const subject = harness({
        project: configuredProject,
        createHarnessHosts: fakeHosts().create,
      });
      const pending = subject.run(flags);

      await waitFor(
        () =>
          subject.io.stderr().includes(`Harness endpoint listening on port ${endpointPort}.`) &&
          (runtimePort === undefined || subject.codeZip.inputs.length > 0),
      );
      await interrupt(pending);

      expect(subject.codeZip.inputs[0]?.port).toBe(runtimePort);
    },
  );

  test.each([
    [{}, "pull", "set:h1,h2", ["orders"]],
    [{ harness: "h1", target: "staging" }, "start:h1", "set:h1", []],
  ] as const)(
    "browser mode pulls or starts in the background and reloads the selection on edit (%o)",
    async (flags, background, reload, agents) => {
      const hosts = fakeHosts({ pull: new Error("offline") });
      const subject = harness({
        project: harnessProject(["h1"]),
        reloaded: harnessProject(["h1", "h2"], runtime("orders")),
        createHarnessHosts: hosts.create,
      });
      const pending = subject.run({ mode: "browser", ...flags });

      await waitFor(() => hosts.calls.includes(background));
      subject.watchers[0]!.onChange();
      await waitFor(() => hosts.calls.includes(reload));
      expect((await inspectorStatus(subject)).map((agent) => agent.name)).toEqual([...agents]);
      await interrupt(pending);

      expect(hosts.calls).toEqual(["create:h1", background, reload]);
      expect(subject.harnessDevAws[0]?.[1]).toBe("target" in flags ? flags.target : "default");
      expect(subject.io.stderr().includes("Harness image pull failed: offline")).toBe(
        background === "pull",
      );
      expect(subject.io.stderr()).toContain("Reloaded agents and harnesses from agentcore.json.");
    },
  );
});
