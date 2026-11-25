import { afterEach, describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessRunner, ProcessStreamer, StreamProcessOptions } from "../../io";
import { MissingToolError } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import { renderBoxProfile } from "../project/templates/boxProfile";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import { ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";
import { BoxDevRunner } from "./box";
import { NO_AUTO_INSTRUMENTATION } from "./codezip";

/** The line of a CodeZip profile that names its runtime's folder. */
const PROFILE = 'read = ["${{ workspace }}/app/agent"]\n';

const NO_TRACES_NOTICE = { type: "status", message: NO_AUTO_INSTRUMENTATION } as const;

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
  await mkdir(join(projectRoot, "app", name, ".venv", "bin"), { recursive: true });
  await writeFile(join(projectRoot, "app", name, ".venv", "bin", "python"), "");
}

/** A project named `Demo` that holds the agent's box profile in .box/agent/local when `profiled`. */
async function scene(
  profiled: boolean,
  boxOnPath = true,
  options: { profile?: string; processEnv?: NodeJS.ProcessEnv; sitecustomize?: boolean } = {},
) {
  const projectRoot = await temp("agentcore-box-project-");
  await mkdir(join(projectRoot, "agentcore"));
  await writeFile(join(projectRoot, "agentcore", "agentcore.json"), '{"name":"Demo"}');
  if (profiled) {
    const local = join(projectRoot, ".box", "agent", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "profile.toml"), options.profile ?? PROFILE);
    await mkdir(join(projectRoot, "app", "agent", ".venv", "bin"), { recursive: true });
    await writeFile(join(projectRoot, "app", "agent", ".venv", "bin", "python"), "");
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
  // The venv's OTEL auto-instrumentation folder, which the finder prints behind its marker.
  const sitecustomizeDir = join(projectRoot, "app", "agent", ".venv", "otel-auto");
  if (options.sitecustomize) {
    await mkdir(sitecustomizeDir, { recursive: true });
    await writeFile(join(sitecustomizeDir, "sitecustomize.py"), "");
  }
  const found: string[][] = [];
  const runProcess: ProcessRunner = async (command, runOptions) => {
    found.push(command);
    if (!options.sitecustomize) throw new Error("no opentelemetry in the venv");
    runOptions.onOutput?.(`AGENTCORE_OTEL_SITECUSTOMIZE=${sitecustomizeDir}\n`);
  };
  const checked: string[] = [];
  const runner = new BoxDevRunner({
    runProcess,
    fallback,
    streamProcess,
    checkTool: async (tool, installHint) => {
      checked.push(tool);
      if (!boxOnPath) throw new MissingToolError(tool, installHint);
    },
    ...(options.processEnv && { processEnv: options.processEnv }),
  });
  return { projectRoot, calls, fallbackRuns, runner, checked, sitecustomizeDir, found };
}

function input(
  projectRoot: string,
  port = 8080,
  protocol?: ProjectRuntime["protocol"],
  entrypoint = "main.py",
  boxProject = true,
  box = true,
): DevServerInput {
  return {
    runtime: {
      name: "agent",
      build: "CodeZip",
      codeLocation: "app/agent",
      protocol,
      entrypoint,
      // create writes box.version only for a box template.
      ...(box && { box: { version: "1.0.0" } }),
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

    await collect(
      runner.run(input(projectRoot, 8080, undefined, "main.py", true, /* box */ false)),
    );

    expect(checked).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
  });

  test("runs the agent's box profile from the runtime's code folder", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", "../../.box/agent/local/profile.toml", "--no-banner"],
    ]);
    expect(calls[0]!.options.cwd).toBe(join(projectRoot, "app", "agent"));
    expect(fallbackRuns).toEqual([]);
    expect(events).toEqual([
      {
        type: "status",
        message: "Starting the agent in a box (box run ../../.box/agent/local/profile.toml)",
      },
      { type: "stdout", line: "Uvicorn running" },
    ]);
  });

  test("runs each runtime with the box profile of that runtime", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);
    await profile(projectRoot, "second");

    await collect(runner.run({ ...secondOf(input(projectRoot)), env: {} }));
    await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(calls.map(({ command }) => command[2])).toEqual([
      "../../.box/second/local/profile.toml",
      "../../.box/agent/local/profile.toml",
    ]);
    expect(calls.map(({ options }) => options.cwd)).toEqual([
      join(projectRoot, "app", "second"),
      join(projectRoot, "app", "agent"),
    ]);
    expect(fallbackRuns).toEqual([]);
  });

  test("starts box in the runtime's folder for a profile create writes, whatever it says", async () => {
    // So the agent's workspace, and the project grant, are app/agent and nothing else of the
    // project: not agentcore/.env.local, which holds the model's key. The folder comes from
    // agentcore.json, so a profile without its header comment starts there too.
    const runtime = resolveRuntimeTemplateShortcut("agent-python-strands-box", {
      runtimeName: "agent",
    });
    const noComments = renderBoxProfile("Demo", runtime, "us-west-2")!
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    const { projectRoot, calls, runner } = await scene(true, true, { profile: noComments });

    await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", "../../.box/agent/local/profile.toml", "--no-banner"],
    ]);
    expect(calls[0]!.options.cwd).toBe(join(projectRoot, "app", "agent"));
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

    test("prefers the shell's value to .env.local's, and says which, with no value", async () => {
      // A wide-scope GITHUB_TOKEN in a shell profile would otherwise silently replace a narrow
      // project token in .env.local.
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: { GITHUB_TOKEN: "ghp_shell" },
      });

      const events = await collect(
        runner.run({ ...input(projectRoot), env: { GITHUB_TOKEN: "ghp_file" } }),
      );

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_shell");
      expect(events).toContainEqual({
        type: "status",
        message:
          "GITHUB_TOKEN, which [egress.github] of the box profile reads, is set in this shell and " +
          `in ${ENV_LOCAL_RELATIVE_PATH} to different values; box uses the shell's`,
      });
      expect(JSON.stringify(events)).not.toMatch(/ghp_shell|ghp_file/);
    });

    test("uses .env.local's value when the shell has none", async () => {
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: {},
      });

      await collect(runner.run({ ...input(projectRoot), env: { GITHUB_TOKEN: "ghp_file" } }));

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_file");
    });

    test("uses .env.local's value, with no warning, when the shell's is blank", async () => {
      // A blank shell value, such as an unset CI secret, hid the .env.local one from the check
      // but not from box run, so dev warned that box would not start, and box started.
      const { projectRoot, calls, runner } = await scene(true, true, {
        profile: GITHUB_PROFILE,
        processEnv: { GITHUB_TOKEN: "" },
      });

      const events = await collect(
        runner.run({ ...input(projectRoot), env: { GITHUB_TOKEN: "ghp_file" } }),
      );

      expect(calls[0]!.options.env!.GITHUB_TOKEN).toBe("ghp_file");
      expect(JSON.stringify(events)).not.toContain("GITHUB_TOKEN for [egress.github]");
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
          "(export GITHUB_TOKEN=...) or put it in " +
          `${ENV_LOCAL_RELATIVE_PATH}, then restart dev.`,
      });
      // box run still starts, so its own error follows the warning.
      expect(calls).toHaveLength(1);
    });
  });

  test("runs the agent the usual way when the project has no box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const events = await collect(
      runner.run(input(projectRoot, 8080, undefined, "main.py", true, /* box */ false)),
    );

    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test("refuses a box runtime when the project has no box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const error = await collect(runner.run(input(projectRoot, 8080, "HTTP", "start.py"))).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as Error).message).toContain(
      'runtime "agent" runs its agent in a box (it has box.version in agentcore.json)',
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(0);
  });

  test("runs the agent the usual way outside a Box project, even with a box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner, checked } = await scene(true);

    const events = await collect(
      runner.run(input(projectRoot, 8080, "HTTP", "main.py", /* boxProject */ false, false)),
    );

    expect(calls).toEqual([]);
    expect(checked).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    // The profile was written for a Box project, so dev says why it does not use it.
    expect(events).toEqual([
      {
        type: "status",
        message: 'Running without a box: agentcore.json has no "projectType": "box"',
      },
      { type: "stdout", line: "fallback" },
    ]);
  });

  test("says nothing about box outside a Box project with no box profile", async () => {
    const { projectRoot, runner } = await scene(false);

    const events = await collect(
      runner.run(input(projectRoot, 8080, "HTTP", "main.py", /* boxProject */ false, false)),
    );

    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test.each([
    ["outside a Box project", false],
    ["in a Box project", true],
  ])("runs a user's own start.py with no box.version the usual way %s", async (_, boxProject) => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const events = await collect(
      runner.run(input(projectRoot, 8080, "HTTP", "start.py", boxProject, /* box */ false)),
    );

    // Only box.version in a Box project makes a runtime boxed, not its entry point.
    expect(calls).toEqual([]);
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
      'runtime "agent" runs its agent in a box (it has box.version), but agentcore.json has no ' +
        '"projectType": "box". Add "projectType": "box" back to agentcore.json, then retry.',
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(0);
  });

  test("says nothing about traces when dev collects none", async () => {
    const { projectRoot, runner } = await scene(true);

    const events = await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(events).not.toContainEqual(NO_TRACES_NOTICE);
  });

  test("sends the agent's traces and box's records to dev's collector, from a dev-time profile", async () => {
    const { projectRoot, calls, runner, sitecustomizeDir } = await scene(true, true, {
      sitecustomize: true,
    });
    await writeFile(
      join(projectRoot, ".box", "agent", "local", "profile.toml"),
      'policies = ["policy.dw"]\n' +
        PROFILE +
        '[agent.env]\nPYTHONPATH = "/mine"\nOTEL_SERVICE_NAME = "mine"\n',
    );
    await writeFile(join(projectRoot, ".box", "agent", "local", "policy.dw"), "// rules\n");
    const local = readFileSync(join(projectRoot, ".box", "agent", "local", "profile.toml"), "utf8");

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", "../../agentcore/.cli/box-dev/agent/profile.toml", "--no-banner"],
    ]);
    expect(events).toContainEqual({
      type: "status",
      message:
        "Traces of the agent and box's records go to the dev collector (box profile agentcore/.cli/box-dev/agent/profile.toml)",
    });
    const dev = parse(
      readFileSync(
        join(projectRoot, "agentcore", ".cli", "box-dev", "agent", "profile.toml"),
        "utf8",
      ),
    ) as Record<string, any>;
    expect(dev.telemetry.agentcore_dev).toEqual({
      kind: "otlp",
      destination: "http://127.0.0.1:4318",
      accepts: ["traces", "logs"],
      include: ["deny", "permit", "trace", "logs"],
    });
    // The user's own values win, and their PYTHONPATH stays after the auto-instrumentation folder.
    expect(dev.agent.env.PYTHONPATH).toBe(`${sitecustomizeDir}:/mine`);
    expect(dev.agent.env.OTEL_SERVICE_NAME).toBe("mine");
    expect(dev.agent.env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(dev.agent.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(
      readFileSync(join(projectRoot, "agentcore", ".cli", "box-dev", "agent", "policy.dw"), "utf8"),
    ).toBe("// rules\n");
    // The committed profile is unchanged.
    expect(readFileSync(join(projectRoot, ".box", "agent", "local", "profile.toml"), "utf8")).toBe(
      local,
    );
  });

  test("sends box's records, but not the agent's spans, to dev's collector when the venv has no auto-instrumentation", async () => {
    const { projectRoot, calls, runner, found } = await scene(true);

    const events = await collect(runner.run(input(projectRoot)));

    expect(found).toHaveLength(1);
    expect(calls.map(({ command }) => command)).toEqual([
      ["box", "run", "../../agentcore/.cli/box-dev/agent/profile.toml", "--no-banner"],
    ]);
    expect(events.slice(0, 2)).toEqual([
      NO_TRACES_NOTICE,
      {
        type: "status",
        message:
          "Box's records go to the dev collector (box profile agentcore/.cli/box-dev/agent/profile.toml)",
      },
    ]);
    const dev = parse(
      readFileSync(
        join(projectRoot, "agentcore", ".cli", "box-dev", "agent", "profile.toml"),
        "utf8",
      ),
    ) as Record<string, any>;
    expect(dev.telemetry.agentcore_dev.destination).toBe("http://127.0.0.1:4318");
    expect(dev.agent.env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(dev.agent.env.PYTHONPATH).toBeUndefined();
  });

  test("runs the local profile, with no dev-time profile, when the runtime turns observability off", async () => {
    const { projectRoot, calls, runner, found } = await scene(true, true, { sitecustomize: true });
    const off = input(projectRoot);
    off.runtime = {
      ...off.runtime,
      envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }],
    } as ProjectRuntime;

    await collect(runner.run(off));

    expect(calls[0]!.command[2]).toBe("../../.box/agent/local/profile.toml");
    expect(found).toEqual([]);
    expect(existsSync(join(projectRoot, "agentcore", ".cli", "box-dev"))).toBe(false);
  });

  test("runs the local profile when dev collects no traces (enableOtel false)", async () => {
    const { projectRoot, calls, runner, found } = await scene(true, true, { sitecustomize: true });

    await collect(runner.run({ ...input(projectRoot), env: {} }));

    expect(calls[0]!.command[2]).toBe("../../.box/agent/local/profile.toml");
    expect(found).toEqual([]);
  });

  test("runs a runtime the usual way when it has no box profile of its own", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);
    const second = input(projectRoot);
    // The second runtime was added without a box template, so it has no box.version.
    const { box: _box, ...plain } = second.runtime;
    second.runtime = { ...plain, name: "second", codeLocation: "app/second" } as ProjectRuntime;

    const events = await collect(runner.run(second));

    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    // The profile of `agent` is not the profile of `second`, so dev says nothing about it.
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test("says why it runs a runtime with its own box profile but no box.version the usual way", async () => {
    const { projectRoot, fallbackRuns, runner } = await scene(false);
    await profile(projectRoot, "second");
    const second = secondOf(input(projectRoot, 8080, undefined, "main.py", true, /* box */ false));

    const events = await collect(runner.run(second));

    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([
      {
        type: "status",
        message: 'Running without a box: runtime "second" has no box.version in agentcore.json',
      },
      { type: "stdout", line: "fallback" },
    ]);
  });

  test("refuses a box runtime that has no box profile of its own, though another runtime has one", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const run = collect(runner.run(secondOf(input(projectRoot))));

    await expect(run).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(run).rejects.toThrow(
      `but ${join(projectRoot, ".box", "second", "local", "profile.toml")} does not exist.`,
    );
    expect(calls).toEqual([]);
    expect(fallbackRuns).toEqual([]);
  });

  test.each([
    ["has no .venv", true],
    ["has the empty .venv that create --skip-install leaves", false],
  ])("tells the user to run uv sync when the runtime %s", async (_, removeVenv) => {
    const { projectRoot, calls, runner } = await scene(true);
    const venv = join(projectRoot, "app", "agent", ".venv");
    await rm(removeVenv ? venv : join(venv, "bin"), { recursive: true });

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
