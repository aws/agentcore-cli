import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { InputValidationError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessEvent, ProcessRunner, ProcessStreamer, StreamProcessOptions } from "../../io";
import { CodeZipDevRunner } from "./codezip";

type ProcessCall = {
  command: string[];
  options: StreamProcessOptions;
};

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runtime(
  overrides: {
    codeLocation?: string;
    entrypoint?: string;
    protocol?: ProjectRuntime["protocol"];
  } = {},
): ProjectRuntime {
  return {
    name: "hello_world",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/hello-world",
    protocol: "HTTP",
    ...overrides,
  } as ProjectRuntime;
}

async function projectRoot(withNodeModules = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-codezip-"));
  tempDirectories.push(root);
  await mkdir(join(root, "app", "hello-world"), { recursive: true });
  await mkdir(join(root, "app", "hello-world", "src"));
  await Promise.all(
    ["main.py", "index.js", "src/main.py", "src/index.ts"].map((path) =>
      writeFile(join(root, "app", "hello-world", path), ""),
    ),
  );
  if (withNodeModules) {
    await mkdir(join(root, "app", "hello-world", "node_modules"));
  }
  return root;
}

function harness(output: ProcessEvent[] = [], probe: { dir?: string; fail?: boolean } = {}) {
  const calls: ProcessCall[] = [];
  const probeCalls: string[][] = [];
  const fakeStreamProcess: ProcessStreamer = async function* (command, options) {
    calls.push({ command, options });
    yield* output;
  };
  const fakeRunProcess: ProcessRunner = async (command, options) => {
    probeCalls.push(command);
    if (probe.fail) throw new Error("probe failed");
    options.onOutput?.(`${probe.dir ?? ""}\n`);
  };
  return {
    calls,
    probeCalls,
    runner: new CodeZipDevRunner({ streamProcess: fakeStreamProcess, runProcess: fakeRunProcess }),
  };
}

function input(root: string, projectRuntime: ProjectRuntime): DevServerInput {
  return {
    runtime: projectRuntime,
    projectRoot: root,
    port: 9000,
    env: { CUSTOM_ENV: "value" },
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<DevEvent>): Promise<DevEvent[]> {
  const collected: DevEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("CodeZipDevRunner", () => {
  test("rejects a missing runtime code directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-codezip-"));
    tempDirectories.push(root);

    await expect(collect(harness().runner.run(input(root, runtime())))).rejects.toThrow(
      /runtime code directory not found/,
    );
  });

  test("rejects code and entrypoint paths outside the project root", async () => {
    const root = await projectRoot();
    const outside = await mkdtemp(join(tmpdir(), "agentcore-codezip-outside-"));
    tempDirectories.push(outside);
    await writeFile(join(outside, "main.py"), "");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await symlink(
      outside,
      join(root, "app", "hello-world", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const directory = join(root, "app", "hello-world");

    const unsafeRuntimes = [
      runtime({ codeLocation: relative(root, outside) }),
      runtime({ codeLocation: "linked" }),
      runtime({ entrypoint: relative(directory, join(outside, "main.py")) }),
      runtime({ entrypoint: join("linked", "main.py") }),
    ];

    for (const projectRuntime of unsafeRuntimes) {
      const { calls, runner } = harness();
      const result = collect(runner.run(input(root, projectRuntime)));
      await expect(result).rejects.toBeInstanceOf(InputValidationError);
      await expect(result).rejects.toThrow("must be within the project root");
      expect(calls).toHaveLength(0);
    }
  });

  test("runs HTTP Python entrypoints with uvicorn", async () => {
    const root = await projectRoot();
    const { calls, runner } = harness([{ type: "stdout", line: "server output" }]);
    const events = await collect(
      runner.run(input(root, runtime({ entrypoint: "src/main.py:application" }))),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual([
      "uv",
      "run",
      "uvicorn",
      "src.main:application",
      "--reload",
      "--host",
      "127.0.0.1",
      "--port",
      "9000",
    ]);
    expect(calls[0]?.options).toMatchObject({
      cwd: join(root, "app", "hello-world"),
      env: { CUSTOM_ENV: "value", PORT: "9000", LOCAL_DEV: "1" },
    });
    expect(events).toEqual([
      { type: "status", message: "Starting development server" },
      { type: "stdout", line: "server output" },
    ]);
  });

  test.each(["MCP", "A2A", "AGUI"] as const)(
    "runs %s Python entrypoints directly",
    async (protocol) => {
      const root = await projectRoot();
      const { calls, runner } = harness();

      await collect(runner.run(input(root, runtime({ protocol, entrypoint: "main.py:handler" }))));

      expect(calls[0]?.command).toEqual(["uv", "run", "python", "main.py"]);
      expect(calls[0]?.options.env?.FASTMCP_PORT).toBe(protocol === "MCP" ? "9000" : undefined);
    },
  );

  test("installs missing Node dependencies before starting tsx", async () => {
    const root = await projectRoot();
    const { calls, runner } = harness([{ type: "stderr", line: "0 errors" }]);
    const events = await collect(
      runner.run(input(root, runtime({ entrypoint: "src/index.ts:handler" }))),
    );

    expect(calls.map(({ command }) => command)).toEqual([
      ["npm", "install"],
      ["npm", "exec", "--", "tsx", "watch", "src/index.ts"],
    ]);
    expect(events).toEqual([
      { type: "status", message: "Installing Node dependencies with npm" },
      { type: "stderr", line: "0 errors" },
      { type: "status", message: "Starting development server" },
      { type: "stderr", line: "0 errors" },
    ]);
  });

  test("starts tsx directly when Node dependencies exist", async () => {
    const root = await projectRoot(true);
    const { calls, runner } = harness();

    await collect(runner.run(input(root, runtime({ entrypoint: "index.js" }))));

    expect(calls.map(({ command }) => command)).toEqual([
      ["npm", "exec", "--", "tsx", "watch", "index.js"],
    ]);
  });
});

describe("CodeZipDevRunner OTEL instrumentation", () => {
  async function sitecustomizeDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "otel-site-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "sitecustomize.py"), "");
    return directory;
  }

  function otelInput(root: string, extraEnv: Record<string, string> = {}): DevServerInput {
    const base = input(root, runtime());
    return {
      ...base,
      env: { ...base.env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", ...extraEnv },
    };
  }

  test("prepends the sitecustomize directory to PYTHONPATH when instrumentation is installed", async () => {
    const root = await projectRoot();
    const directory = await sitecustomizeDir();
    const { calls, probeCalls, runner } = harness([], { dir: directory });

    await collect(runner.run(otelInput(root)));

    expect(probeCalls[0]?.slice(0, 4)).toEqual(["uv", "run", "python", "-c"]);
    expect(calls[0]?.options.env?.PYTHONPATH).toBe(directory);
  });

  test("preserves an existing PYTHONPATH", async () => {
    const root = await projectRoot();
    const directory = await sitecustomizeDir();
    const { calls, runner } = harness([], { dir: directory });

    await collect(runner.run(otelInput(root, { PYTHONPATH: "/existing" })));

    expect(calls[0]?.options.env?.PYTHONPATH).toBe(`${directory}${delimiter}/existing`);
  });

  test("does not probe without an OTEL endpoint or for Node entrypoints", async () => {
    const root = await projectRoot(true);
    const { probeCalls, runner } = harness();

    await collect(runner.run(input(root, runtime())));
    await collect(runner.run({ ...otelInput(root), runtime: runtime({ entrypoint: "index.js" }) }));

    expect(probeCalls).toEqual([]);
  });

  test.each([
    ["probe failure", { fail: true }],
    ["missing sitecustomize.py", { dir: "/nonexistent" }],
  ] as const)("warns and starts untraced on %s", async (_case, probe) => {
    const root = await projectRoot();
    const { calls, probeCalls, runner } = harness([], probe);

    const events = await collect(runner.run(otelInput(root)));

    expect(probeCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.env?.PYTHONPATH).toBeUndefined();
    expect(events).toContainEqual({
      type: "status",
      message: expect.stringContaining("traces will not be collected"),
    });
  });
});
