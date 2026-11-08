import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProcessStreamer, StreamProcessOptions } from "../../io";
import { BoxDevRunner } from "./box";

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

/** A project named `Demo`, and a profiles folder that holds its box profile when `profiled`. */
async function scene(profiled: boolean) {
  const projectRoot = await temp("agentcore-box-project-");
  await mkdir(join(projectRoot, "agentcore"));
  await writeFile(join(projectRoot, "agentcore", "agentcore.json"), '{"name":"Demo"}');
  const profilesDirectory = await temp("agentcore-box-profiles-");
  if (profiled) {
    await mkdir(join(profilesDirectory, "Demo"));
    await writeFile(join(profilesDirectory, "Demo", "profile.toml"), "");
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
  const runner = new BoxDevRunner({ fallback, streamProcess, profilesDirectory });
  return { projectRoot, calls, fallbackRuns, runner };
}

function input(projectRoot: string, port = 8080): DevServerInput {
  return {
    runtime: { name: "agent", build: "CodeZip" } as ProjectRuntime,
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
  test("runs the project's box profile from the project folder", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(true);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls.map(({ command }) => command)).toEqual([["box", "run", "Demo", "--no-banner"]]);
    expect(calls[0]!.options.cwd).toBe(projectRoot);
    expect(fallbackRuns).toEqual([]);
    expect(events).toEqual([
      { type: "status", message: "Starting the agent in a box (box run Demo)" },
      { type: "stdout", line: "Uvicorn running" },
    ]);
  });

  test("runs the agent the usual way when the project has no box profile", async () => {
    const { projectRoot, calls, fallbackRuns, runner } = await scene(false);

    const events = await collect(runner.run(input(projectRoot)));

    expect(calls).toEqual([]);
    expect(fallbackRuns).toHaveLength(1);
    expect(events).toEqual([{ type: "stdout", line: "fallback" }]);
  });

  test("refuses a dev port the box does not listen on", async () => {
    const { projectRoot, calls, runner } = await scene(true);

    const error = await collect(runner.run(input(projectRoot, 8081))).catch((caught) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("listens on port 8080, but dev chose port 8081");
    expect(calls).toEqual([]);
  });
});
