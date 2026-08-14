import { describe, expect, test } from "bun:test";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { InputValidationError, ResourceNotFoundError } from "../../../errors";
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

function fakeCollector() {
  const starts: { tracesDirectory: string; signal?: AbortSignal }[] = [];
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

describe("project dev selection and dispatch", () => {
  test.each([
    [project(), {}, "This project has no runtimes", InputValidationError],
    [
      project(runtime("orders"), runtime("support", "Container")),
      {},
      "Use --agent to select one. Available runtimes: orders, support",
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
    await subject.run();

    expect(checked).toEqual([8080, 8081]);
    expect(subject.codeZip.inputs[0]?.port).toBe(8081);
    expect(subject.io.stderr()).toContain("Port 8080 is in use; using 8081.");
  });
});

describe("project dev trace collection", () => {
  test("starts the collector, announces it, and points a CodeZip agent at loopback", async () => {
    const subject = harness();
    await subject.run();

    expect(subject.collector.starts).toEqual([
      {
        tracesDirectory: "/workspace/project/agentcore/.cli/traces/otlp",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(subject.io.stderr()).toContain("OTEL collector listening on port 43180");
    expect(subject.codeZip.inputs[0]?.env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43180",
      OTEL_SERVICE_NAME: "orders",
    });
    expect(subject.collector.state.closed).toBe(1);
  });

  test("--no-traces skips the collector entirely", async () => {
    const subject = harness();
    await subject.run({ traces: false });

    expect(subject.collector.starts).toHaveLength(0);
    expect(subject.codeZip.inputs[0]?.env).toEqual({ FROM_LOADER: "yes" });
  });

  test("a runtime with instrumentation disabled skips the collector", async () => {
    const disabled = { ...runtime(), instrumentation: { enableOtel: false } } as ProjectRuntime;
    const subject = harness({ project: project(disabled) });
    await subject.run();

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

    await expect(subject.run()).rejects.toThrow("runner failed");
    expect(subject.collector.state.closed).toBe(1);
  });
});

test("project dev renders human and NDJSON output", async () => {
  const events: DevEvent[] = [
    { type: "status", message: "Starting" },
    { type: "stdout", line: "agent output" },
    { type: "stderr", line: "agent warning" },
  ];

  for (const json of [false, true]) {
    const subject = harness({ codeZip: captureRunner(events), json });
    await subject.run({ traces: false });
    expect(subject.io.stdout()).toBe(
      json ? events.map((event) => JSON.stringify(event)).join("\n") : "agent output",
    );
    expect(subject.io.stderr()).toBe(json ? "" : "Starting\nagent warning");
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
      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
        reported: true,
        exitCode: 130,
      });
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

    await expect(harness({ codeZip }).run()).rejects.toBe(failure);
  });
});
