import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessEvent, ProcessStreamer, StreamProcessOptions } from "../../io";
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
  overrides: { entrypoint?: string; protocol?: ProjectRuntime["protocol"] } = {},
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
  if (withNodeModules) {
    await mkdir(join(root, "app", "hello-world", "node_modules"));
  }
  return root;
}

function harness(output: ProcessEvent[] = []) {
  const calls: ProcessCall[] = [];
  const fakeStreamProcess: ProcessStreamer = async function* (command, options) {
    calls.push({ command, options });
    yield* output;
  };
  return {
    calls,
    runner: new CodeZipDevRunner({ streamProcess: fakeStreamProcess }),
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
