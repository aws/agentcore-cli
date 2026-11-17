import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError, ResourceNotFoundError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessStreamer, StreamProcessOptions } from "../../io";
import { BoxDevRunner } from "./box";

/** The line of a CodeZip profile that names its runtime's folder. */
const PROFILE = 'read = ["${{ workspace }}/app/agent"]\n';

const TRACES_NOTICE = {
  type: "status",
  message: "Traces are not collected when the agent runs in a box",
} as const;

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temp(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

/** A project named `Demo` that holds its box profile in .box/profile.toml when `profiled`. */
async function scene(profiled: boolean, releaseBox?: string) {
  const projectRoot = await temp("agentcore-box-project-");
  await mkdir(join(projectRoot, "agentcore"));
  await writeFile(join(projectRoot, "agentcore", "agentcore.json"), '{"name":"Demo"}');
  if (profiled) {
    await mkdir(join(projectRoot, ".box"));
    await writeFile(join(projectRoot, ".box", "profile.toml"), PROFILE);
    await mkdir(join(projectRoot, "app", "agent", ".venv"), { recursive: true });
  }

  const calls: { command: string[]; options: StreamProcessOptions }[] = [];
  const streamProcess: ProcessStreamer = async function* (command, options) {
    calls.push({ command, options });
    yield { type: "stdout", line: "Uvicorn running" };
  };
  const fallbackRuns: DevServerInput[] = [];
  const fallback: DevRunner = {
    async *run(input) {
      fallbackRuns.push(input);
      yield { type: "stdout", line: "fallback" };
    },
  };
  // No release build for this machine, so box comes from PATH, unless the test names one.
  const versions: (string | undefined)[] = [];
  const runner = new BoxDevRunner({
    fallback,
    streamProcess,
    resolveBox: async (version) => {
      versions.push(version);
      return releaseBox;
    },
  });
  return { projectRoot, calls, fallbackRuns, runner, versions };
}

function input(
  projectRoot: string,
  port = 8080,
  protocol?: ProjectRuntime["protocol"],
  entrypoint = "main.py",
): DevServerInput {
  return {
    runtime: {
      name: "agent",
      build: "CodeZip",
      codeLocation: "app/agent",
      protocol,
      entrypoint,
    } as ProjectRuntime,
    projectRoot,
    port,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<DevEvent>): Promise<DevEvent[]> {
  const collected: DevEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("BoxDevRunner", () => {
  test("says box is downloading before it waits for a first download", async () => {
    const projectRoot = await temp("agentcore-box-project-");
    await mkdir(join(projectRoot, ".box"));
    await writeFile(join(projectRoot, ".box", "profile.toml"), PROFILE);
    await mkdir(join(projectRoot, "app", "agent", ".venv"), { recursive: true });
    const box = "/home/me/.agentcore/box/1.0.0-aarch64-apple-darwin/box";
    const runner = new BoxDevRunner({
      fallback: { async *run() {} },
      streamProcess: async function* () {},
      resolveBox: async (_version, onDownload) => {
        onDownload("downloading box 1.0.0 for this machine from https://example.com/box.tar.gz");
        return box;
      },
    });

    const events = await collect(runner.run(input(projectRoot)));

    expect(events).toEqual([
      {
        type: "status",
        message: "downloading box 1.0.0 for this machine from https://example.com/box.tar.gz",
      },
      TRACES_NOTICE,
      { type: "status", message: `Starting the agent in a box (${box} run .box/profile.toml)` },
    ]);
  });

  test("asks for the box of the runtime's box.version", async () => {
    const { projectRoot, runner, versions } = await scene(true);
    const pinned = input(projectRoot);
    pinned.runtime = { ...pinned.runtime, box: { version: "2.0.0" } };

    await collect(runner.run(pinned));
    await collect(runner.run(input(projectRoot)));

    expect(versions).toEqual(["2.0.0", undefined]);
  });

  test("runs the release's box for this machine when it has one", async () => {
    const box = "/home/me/.agentcore/box/1.0.0-aarch64-apple-darwin/box";
    const { projectRoot, calls, runner } = await scene(true, box);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command)).toEqual([
      [box, "run", ".box/profile.toml", "--no-banner"],
    ]);
    expect(events[1]).toEqual({
      type: "status",
      message: `Starting the agent in a box (${box} run .box/profile.toml)`,
    });
  });

  test("runs the project's box profile from the project folder", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", ".box/profile.toml", "--no-banner"],
    ]);
    expect(calls[0]!.options.cwd).toBe(projectRoot);
    expect(fallbackRuns).toEqual([]);
    expect(events).toEqual([
      TRACES_NOTICE,
      { type: "status", message: "Starting the agent in a box (box run .box/profile.toml)" },
      { type: "stdout", line: "Uvicorn running" },
    ]);
  });

  test("hands box run the .env.local values, so it can attach the API key, and not dev's OTEL ones", async () => {
    const { projectRoot, calls, runner } = await scene(true);

    await collect(
      runner.run({
        ...input(projectRoot),
        env: {
          AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY: "sk-real",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
          OTEL_SERVICE_NAME: "agent",
        },
      }),
    );

    const env = calls[0]!.options.env!;
    expect(env.AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY).toBe("sk-real");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
    expect(env.OTEL_SERVICE_NAME).toBe(process.env.OTEL_SERVICE_NAME);
  });

  test("runs the agent the usual way when the project has no box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test("refuses a runtime that starts box, when the project has no box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const error = await collect(runner.run(input(projectRoot, 8080, "HTTP", "start.py"))).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as Error).message).toContain(
      'runtime "agent" runs its agent in a box (entrypoint start.py)',
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(0);
  });

  test("says nothing about traces when dev collects none", async () => {
    const { projectRoot, runner } = await scene(true);

    const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(events).not.toContainEqual(TRACES_NOTICE);
  });

  test("runs another runtime the usual way, since the profile is the first runtime's", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);
    const second = input(projectRoot);
    second.runtime = {
      ...second.runtime,
      name: "second",
      codeLocation: "app/second",
    } as ProjectRuntime;

    const events = await collect(runner.run(second));

    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([
      {
        type: "status",
        message: expect.stringContaining("is the box profile of another runtime"),
      },
      { type: "stdout", line: "fallback" },
    ]);
  });

  test("tells the user to run uv sync when the runtime has no .venv", async () => {
    const { projectRoot, calls, runner } = await scene(true);
    await rm(join(projectRoot, "app", "agent", ".venv"), { recursive: true });

    const run = collect(runner.run(input(projectRoot)));

    await expect(run).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(run).rejects.toThrow("`uv sync` in app/agent");
    expect(calls).toEqual([]);
  });

  test.each([
    {
      name: "expects the dev port of the runtime's protocol",
      port: 8080,
      protocol: "MCP",
      listen: 8000,
    },
    {
      name: "refuses a dev port the box does not listen on",
      port: 8081,
      protocol: undefined,
      listen: 8080,
    },
  ] as const)("$name", async ({ port, protocol, listen }) => {
    const { projectRoot, calls, runner } = await scene(true);

    const run = collect(runner.run(input(projectRoot, port, protocol)));

    await expect(run).rejects.toBeInstanceOf(InputValidationError);
    await expect(run).rejects.toThrow(
      `listens on port ${listen}, but dev chose port ${port}. Free port ${listen}, then retry.`,
    );
    expect(calls).toEqual([]);
  });
});
