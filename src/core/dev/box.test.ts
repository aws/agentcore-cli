import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessStreamer, StreamProcessOptions } from "../../io";
import { MissingToolError } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import { ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";
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

/** Writes the local box profile of the runtime `name`, and the venv of its app folder. */
async function profile(projectRoot: string, name: string): Promise<void> {
  const local = join(projectRoot, ".box", name, "local");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "profile.toml"), PROFILE.replace("app/agent", `app/${name}`));
  await mkdir(join(projectRoot, "app", name, ".venv"), { recursive: true });
}

/** A project named `Demo` that holds the agent's box profile in .box/agent/local when `profiled`. */
async function scene(
  profiled: boolean,
  boxOnPath = true,
  options: { profile?: string; processEnv?: NodeJS.ProcessEnv } = {},
) {
  const projectRoot = await temp("agentcore-box-project-");
  await mkdir(join(projectRoot, "agentcore"));
  await writeFile(join(projectRoot, "agentcore", "agentcore.json"), '{"name":"Demo"}');
  if (profiled) {
    const local = join(projectRoot, ".box", "agent", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "profile.toml"), options.profile ?? PROFILE);
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
  const checked: string[] = [];
  const runner = new BoxDevRunner({
    fallback,
    streamProcess,
    checkTool: async (tool, installHint) => {
      checked.push(tool);
      if (!boxOnPath) throw new MissingToolError(tool, installHint);
    },
    ...(options.processEnv && { processEnv: options.processEnv }),
  });
  return { projectRoot, calls, fallbackRuns, runner, checked };
}

function input(
  projectRoot: string,
  port = 8080,
  protocol?: ProjectRuntime["protocol"],
  entrypoint = "main.py",
  boxProject = true,
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
    boxProject,
    port,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
    signal: new AbortController().signal,
  };
}

/** `agent`'s dev input for the runtime `second`, in app/second. */
function secondOf(agent: DevServerInput): DevServerInput {
  return {
    ...agent,
    runtime: { ...agent.runtime, name: "second", codeLocation: "app/second" } as ProjectRuntime,
  };
}

async function collect(events: AsyncIterable<DevEvent>): Promise<DevEvent[]> {
  const collected: DevEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("BoxDevRunner", () => {
  test("asks the user to install box when it is not on PATH, and runs nothing", async () => {
    const { projectRoot, calls, runner } = await scene(true, false);

    const run = collect(runner.run(input(projectRoot)));

    await expect(run).rejects.toBeInstanceOf(MissingToolError);
    await expect(run).rejects.toThrow(`'box' was not found on your PATH. ${BOX_INSTALL_HINT}`);
    expect(calls).toEqual([]);
  });

  test("needs no box for a project without a box profile", async () => {
    const { projectRoot, checked, fallbackRuns, runner } = await scene(false, false);

    await collect(runner.run(input(projectRoot)));

    expect(checked).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
  });

  test("runs the project's box profile from the project folder", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", ".box/agent/local/profile.toml", "--no-banner"],
    ]);
    expect(calls[0]!.options.cwd).toBe(projectRoot);
    expect(fallbackRuns).toEqual([]);
    expect(events).toEqual([
      TRACES_NOTICE,
      {
        type: "status",
        message: "Starting the agent in a box (box run .box/agent/local/profile.toml)",
      },
      { type: "stdout", line: "Uvicorn running" },
    ]);
  });

  test("runs each runtime with the box profile of that runtime", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);
    await profile(projectRoot, "second");

    await collect(runner.run(secondOf(input(projectRoot))));
    await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command[2])).toEqual([
      ".box/second/local/profile.toml",
      ".box/agent/local/profile.toml",
    ]);
    expect(fallbackRuns).toEqual([]);
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

  describe("with an env:// key in the profile", () => {
    const GITHUB_PROFILE =
      PROFILE +
      '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';

    test("hands box run the shell's value, and writes no .env.local", async () => {
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: { GITHUB_TOKEN: "ghp_shell" },
      });

      const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_shell");
      expect(existsSync(join(projectRoot, "agentcore", ".env.local"))).toBe(false);
      expect(events.some((event) => "message" in event && event.message.includes("not set"))).toBe(
        false,
      );
    });

    test("prefers the shell's value to .env.local's", async () => {
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: { GITHUB_TOKEN: "ghp_shell" },
      });

      await collect(runner.run({ ...input(projectRoot), env: { GITHUB_TOKEN: "ghp_file" } }));

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_shell");
    });

    test("uses .env.local's value when the shell has none", async () => {
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: {},
      });

      await collect(runner.run({ ...input(projectRoot), env: { GITHUB_TOKEN: "ghp_file" } }));

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_file");
    });

    test("warns when neither has it, before box run reports it", async () => {
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: {},
      });

      const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

      expect(events).toContainEqual({
        type: "status",
        message:
          "the box profile .box/agent/local/profile.toml reads GITHUB_TOKEN for [egress.github], " +
          "but it is not set, and box does not start without it. Export it in this shell " +
          `(export GITHUB_TOKEN=...) or put it in ${ENV_LOCAL_RELATIVE_PATH}, then restart dev.`,
      });
      // box run still starts, so its own error follows the warning.
      expect(calls).toHaveLength(1);
    });
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

  test("runs the agent the usual way outside a Box project, even with a box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner, checked } = await scene(true);

    const events = await collect(
      runner.run(input(projectRoot, 8080, "HTTP", "main.py", /* boxProject */ false)),
    );

    expect(calls).toEqual([]);
    expect(checked).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test('refuses a runtime that starts box when agentcore.json has no "projectType": "box"', async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const error = await collect(
      runner.run(input(projectRoot, 8080, "HTTP", "start.py", /* boxProject */ false)),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toBe(
      'runtime "agent" runs its agent in a box (start.py), but agentcore.json has no ' +
        '"projectType": "box". Add "projectType": "box" back to agentcore.json, then retry.',
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(0);
  });

  test("says nothing about traces when dev collects none", async () => {
    const { projectRoot, runner } = await scene(true);

    const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(events).not.toContainEqual(TRACES_NOTICE);
  });

  test("runs a runtime the usual way when it has no box profile of its own", async () => {
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
    // The profile of `agent` is not the profile of `second`, so dev says nothing about it.
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test("refuses a box runtime that has no box profile of its own, though another runtime has one", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const run = collect(runner.run(secondOf(input(projectRoot, 8080, "HTTP", "start.py"))));

    await expect(run).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(run).rejects.toThrow(
      `but ${join(projectRoot, ".box", "second", "local", "profile.toml")} does not exist.`,
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toEqual([]);
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
