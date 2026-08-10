import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InputValidationError, InvalidEnvironmentError } from "../../errors";
import type { DevEvent, DevServerInput } from "../../handlers/project/dev/types";
import {
  MissingToolError,
  type ProcessEvent,
  type ProcessStreamer,
  type StreamProcessOptions,
} from "../../io";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { ContainerDevRunner } from "./container";

type ProcessCall = {
  command: string[];
  options: StreamProcessOptions;
};

type StreamBehavior = (
  command: string[],
  options: StreamProcessOptions,
) => AsyncIterable<ProcessEvent> | Iterable<ProcessEvent>;

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type RuntimeOverrides = Partial<Omit<ProjectRuntime, "buildContextPath" | "dockerfile">> & {
  buildContextPath?: string;
  dockerfile?: string;
};

function runtime(overrides: RuntimeOverrides = {}): ProjectRuntime {
  return {
    name: "Hello_World",
    build: "Container",
    entrypoint: "main.py",
    codeLocation: "app/hello-world",
    protocol: "HTTP",
    ...overrides,
  } as ProjectRuntime;
}

async function projectRoot(projectRuntime: ProjectRuntime = runtime()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
  tempDirectories.push(root);
  const context = join(root, projectRuntime.buildContextPath ?? projectRuntime.codeLocation);
  await mkdir(context, { recursive: true });
  await writeFile(join(context, projectRuntime.dockerfile ?? "Dockerfile"), "FROM scratch\n");
  return root;
}

function harness(
  config: {
    available?: (tool: string, probeArgs?: string[]) => Promise<boolean>;
    stream?: StreamBehavior;
    awsDirectory?: string;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
) {
  const calls: ProcessCall[] = [];
  const fakeStreamProcess: ProcessStreamer = async function* (command, options) {
    calls.push({ command, options });
    if (config.stream) yield* config.stream(command, options);
  };
  return {
    calls,
    runner: new ContainerDevRunner({
      streamProcess: fakeStreamProcess,
      toolAvailable:
        config.available ??
        (async (tool) => {
          return tool === "docker";
        }),
      awsDirectory: config.awsDirectory ?? join(tmpdir(), "agentcore-container-no-aws"),
      processEnv: config.processEnv ?? {
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
      },
    }),
  };
}

function input(
  root: string,
  projectRuntime: ProjectRuntime,
  signal = new AbortController().signal,
): DevServerInput {
  return {
    runtime: projectRuntime,
    projectRoot: root,
    port: 3000,
    env: { API_KEY: "super-secret" },
    signal,
  };
}

async function collect(events: AsyncIterable<DevEvent>): Promise<DevEvent[]> {
  const collected: DevEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function* rejectedEvents(error: unknown): AsyncGenerator<ProcessEvent, void> {
  yield* [];
  throw error;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function imageTag(projectRoot: string): string {
  return `agentcore-dev/hello_world-${hashString(resolve(projectRoot))}`;
}

function containerName(projectRoot: string): string {
  return `agentcore-dev-hello_world-${hashString(resolve(projectRoot))}`;
}

function commandCall(calls: ProcessCall[], operation: "build" | "run"): ProcessCall {
  const call = calls.find(({ command }) => command[1] === operation);
  if (!call) throw new Error(`${operation} command was not called`);
  return call;
}

describe("ContainerDevRunner", () => {
  test("builds with a widened context and redacts build arg values from errors", async () => {
    const projectRuntime = runtime({
      buildContextPath: ".",
      dockerfile: "docker/Dockerfile",
      customDockerBuildArgs: { AGENT_NAME: "hello-world", TARGET: "development" },
    });
    const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
    tempDirectories.push(root);
    await mkdir(join(root, "docker"), { recursive: true });
    await writeFile(join(root, "docker", "Dockerfile"), "FROM scratch\n");
    const { calls, runner } = harness();

    await collect(runner.run(input(root, projectRuntime)));

    const build = commandCall(calls, "build");
    expect(build.command).toEqual([
      "docker",
      "build",
      "-f",
      "docker/Dockerfile",
      "-t",
      imageTag(root),
      "--build-arg",
      "AGENT_NAME=hello-world",
      "--build-arg",
      "TARGET=development",
      ".",
    ]);
    expect(build.options.cwd).toBe(root);
    expect(build.options.env).toBe(process.env);
    expect(build.options.redactedCommand).toContain("AGENT_NAME=<redacted>");
    expect(build.options.redactedCommand).toContain("TARGET=<redacted>");
    expect(build.options.redactedCommand?.join(" ")).not.toContain("hello-world");
    expect(build.options.redactedCommand?.join(" ")).not.toContain("development");

    const dockerignore = await readFile(join(root, ".dockerignore"), "utf8");
    for (const pattern of [".env", "**/.env", "**/node_modules", "agentcore/"]) {
      expect(dockerignore).toContain(pattern);
    }
  });

  test.each([
    ["HTTP", 8080, "HTTP"],
    ["MCP", 8000, "MCP"],
    ["A2A", 9000, "A2A"],
    ["AGUI", 8080, "AGUI"],
    ["the default protocol", 8080, undefined],
  ] as const)("maps %s to container port %d", async (_label, containerPort, protocol) => {
    const projectRuntime = runtime({ protocol });
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness();

    await collect(runner.run(input(root, projectRuntime)));

    const run = commandCall(calls, "run");
    expect(run.command).toEqual([
      "docker",
      "run",
      "--rm",
      "--name",
      containerName(root),
      "-p",
      `127.0.0.1:3000:${containerPort}`,
      "-e",
      "AWS_ACCESS_KEY_ID",
      "-e",
      "AWS_SECRET_ACCESS_KEY",
      "-e",
      "API_KEY",
      "-e",
      "PORT",
      "-e",
      "LOCAL_DEV",
      ...(protocol === "MCP" ? ["-e", "FASTMCP_PORT"] : []),
      imageTag(root),
    ]);
    expect(run.options.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      API_KEY: "super-secret",
      PORT: String(containerPort),
      LOCAL_DEV: "1",
      ...(protocol === "MCP" ? { FASTMCP_PORT: "8000" } : {}),
    });
    expect(run.command.join(" ")).not.toContain("super-secret");
    expect(run.command.join(" ")).not.toContain("test-secret-key");
  });

  test("uses a shared AWS config and rejects missing credentials", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const awsDirectory = join(root, ".aws");
    await mkdir(awsDirectory);
    await writeFile(join(awsDirectory, "config"), "[profile sandbox]\nregion=us-east-1\n");
    const { calls, runner } = harness({
      awsDirectory,
      processEnv: { AWS_PROFILE: "sandbox", AWS_REGION: "us-east-1" },
    });

    await collect(runner.run(input(root, projectRuntime)));

    const run = commandCall(calls, "run");
    expect(run.command).toContain(`${awsDirectory}:/aws-config:ro`);
    expect(run.command).toContain("AWS_PROFILE");
    expect(run.command).toContain("AWS_CONFIG_FILE");
    expect(run.options.env).toMatchObject({
      AWS_PROFILE: "sandbox",
      AWS_REGION: "us-east-1",
      AWS_CONFIG_FILE: "/aws-config/config",
      AWS_SHARED_CREDENTIALS_FILE: "/aws-config/credentials",
    });
    expect(run.command.join(" ")).not.toContain("sandbox");

    const missing = harness({
      awsDirectory: join(root, "missing-aws"),
      processEnv: {},
    });
    const missingCredentials = collect(missing.runner.run(input(root, projectRuntime)));
    await expect(missingCredentials).rejects.toBeInstanceOf(InvalidEnvironmentError);
    await expect(missingCredentials).rejects.toThrow(
      "Unable to resolve AWS credentials for the container",
    );
    expect(missing.calls).toHaveLength(0);
  });

  test("preserves an existing build context .dockerignore", async () => {
    const projectRuntime = runtime({ buildContextPath: "." });
    const root = await projectRoot(projectRuntime);
    const dockerignore = join(root, ".dockerignore");
    await writeFile(dockerignore, "# user owned\ncustom-pattern\n");
    const { runner } = harness();

    await collect(runner.run(input(root, projectRuntime)));

    expect(await readFile(dockerignore, "utf8")).toBe("# user owned\ncustom-pattern\n");
  });

  test("scopes image and container names to the project root", async () => {
    const projectRuntime = runtime();
    const firstRoot = await projectRoot(projectRuntime);
    const secondRoot = await projectRoot(projectRuntime);
    const first = harness();
    const second = harness();

    await collect(first.runner.run(input(firstRoot, projectRuntime)));
    await collect(second.runner.run(input(secondRoot, projectRuntime)));

    expect(commandCall(first.calls, "build").command).toContain(imageTag(firstRoot));
    expect(commandCall(second.calls, "build").command).toContain(imageTag(secondRoot));
    expect(imageTag(firstRoot)).not.toBe(imageTag(secondRoot));
    expect(first.calls[0]?.command).toContain(containerName(firstRoot));
    expect(second.calls[0]?.command).toContain(containerName(secondRoot));
    expect(containerName(firstRoot)).not.toBe(containerName(secondRoot));
  });

  test("limits image names to two consecutive underscores", async () => {
    const projectRuntime = runtime({ name: "Hello___World" });
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness();

    await collect(runner.run(input(root, projectRuntime)));

    expect(commandCall(calls, "build").command).toContain(
      `agentcore-dev/hello__world-${hashString(resolve(root))}`,
    );
  });

  test("supplies app variable values through the container CLI environment", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness();
    const runInput = input(root, projectRuntime);
    runInput.env = { ...runInput.env, DOCKER_HOST: "tcp://application-value" };

    await collect(runner.run(runInput));

    const run = commandCall(calls, "run");
    expect(run.command).toContain("DOCKER_HOST");
    expect(run.command.join(" ")).not.toContain("tcp://application-value");
    expect(run.options.env?.DOCKER_HOST).toBe("tcp://application-value");
  });

  test("selects the first tool that supports container builds", async () => {
    const probes: Array<[string, string[] | undefined]> = [];
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      available: async (tool, probeArgs) => {
        probes.push([tool, probeArgs]);
        return tool === "podman";
      },
    });

    await collect(runner.run(input(root, projectRuntime)));

    expect(probes).toEqual([
      ["docker", undefined],
      ["podman", undefined],
      ["podman", ["build", "--help"]],
    ]);
    expect(commandCall(calls, "build").command[0]).toBe("podman");
    expect(commandCall(calls, "run").command[0]).toBe("podman");
  });

  test("skips a version shim that cannot build", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      available: async (tool, probeArgs) => {
        if (tool === "docker") return probeArgs === undefined;
        return tool === "podman";
      },
    });

    await collect(runner.run(input(root, projectRuntime)));

    expect(commandCall(calls, "build").command[0]).toBe("podman");
  });

  test("falls back to finch when docker and podman are unavailable", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      available: async (tool) => tool === "finch",
    });

    await collect(runner.run(input(root, projectRuntime)));

    expect(commandCall(calls, "build").command[0]).toBe("finch");
  });

  test("passes explicit build arg values to finch", async () => {
    const projectRuntime = runtime({ customDockerBuildArgs: { AGENT_NAME: "hello-world" } });
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      available: async (tool) => tool === "finch",
    });

    await collect(runner.run(input(root, projectRuntime)));

    expect(commandCall(calls, "build").command).toContain("AGENT_NAME=hello-world");
  });

  test("suggests initializing the Finch VM when its build probe fails", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({
      available: async (tool, probeArgs) => tool === "finch" && probeArgs === undefined,
    });

    const promise = collect(runner.run(input(root, projectRuntime)));

    await expect(promise).rejects.toBeInstanceOf(InvalidEnvironmentError);
    await expect(promise).rejects.toThrow("finch vm init");
  });

  test("throws a useful error when no container runtime is available", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({ available: async () => false });

    const promise = collect(runner.run(input(root, projectRuntime)));

    await expect(promise).rejects.toBeInstanceOf(MissingToolError);
    await expect(promise).rejects.toThrow(/Docker.*Podman.*Finch/);
  });

  test("does not probe tools or mutate the project when already aborted", async () => {
    const projectRuntime = runtime({ buildContextPath: "." });
    const root = await projectRoot(projectRuntime);
    const controller = new AbortController();
    controller.abort();
    const probes: string[] = [];
    const { calls, runner } = harness({
      available: async (tool) => {
        probes.push(tool);
        return true;
      },
    });

    await expect(
      collect(runner.run(input(root, projectRuntime, controller.signal))),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(probes).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await expect(readFile(join(root, ".dockerignore"), "utf8")).rejects.toThrow();
  });

  test("stops after tool detection when aborted during probing", async () => {
    const projectRuntime = runtime({ buildContextPath: "." });
    const root = await projectRoot(projectRuntime);
    const controller = new AbortController();
    const probes: string[] = [];
    const { calls, runner } = harness({
      available: async (tool) => {
        probes.push(tool);
        controller.abort();
        return false;
      },
    });

    await expect(
      collect(runner.run(input(root, projectRuntime, controller.signal))),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(probes).toEqual(["docker"]);
    expect(calls).toHaveLength(0);
    await expect(readFile(join(root, ".dockerignore"), "utf8")).rejects.toThrow();
  });

  test("does not build when aborted during stale container cleanup", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const controller = new AbortController();
    const { calls, runner } = harness({
      stream: async function* (command) {
        if (command[1] === "rm") {
          await Promise.resolve();
          controller.abort();
        }
        yield* [];
      },
    });

    await expect(
      collect(runner.run(input(root, projectRuntime, controller.signal))),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls.map(({ command }) => command[1])).toEqual(["rm"]);
  });

  test("rejects build contexts outside the project root, including symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
    const outside = await mkdtemp(join(tmpdir(), "agentcore-container-outside-"));
    tempDirectories.push(root, outside);
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const probes: string[] = [];

    for (const buildContextPath of ["..", "linked"]) {
      const { calls, runner } = harness({
        available: async (tool) => {
          probes.push(tool);
          return true;
        },
      });

      const escapedContext = collect(runner.run(input(root, runtime({ buildContextPath }))));
      await expect(escapedContext).rejects.toBeInstanceOf(InputValidationError);
      await expect(escapedContext).rejects.toThrow(
        "container build context must be within the project root",
      );
      expect(calls).toHaveLength(0);
    }

    expect(probes).toHaveLength(0);
    await expect(readFile(join(outside, ".dockerignore"), "utf8")).rejects.toThrow();
  });

  test("rejects a build context that is not a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
    tempDirectories.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "hello-world"), "not a directory");
    const probes: string[] = [];
    const { calls, runner } = harness({
      available: async (tool) => {
        probes.push(tool);
        return true;
      },
    });

    const promise = collect(runner.run(input(root, runtime())));

    await expect(promise).rejects.toBeInstanceOf(InputValidationError);
    await expect(promise).rejects.toThrow(/build context directory not found/);
    expect(probes).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("rejects a Dockerfile that is not a file", async () => {
    const projectRuntime = runtime();
    const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
    tempDirectories.push(root);
    await mkdir(join(root, projectRuntime.codeLocation, "Dockerfile"), { recursive: true });
    const probes: string[] = [];
    const { calls, runner } = harness({
      available: async (tool) => {
        probes.push(tool);
        return true;
      },
    });

    const promise = collect(runner.run(input(root, projectRuntime)));

    await expect(promise).rejects.toBeInstanceOf(InputValidationError);
    await expect(promise).rejects.toThrow(/Dockerfile not found/);
    expect(probes).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("removes stale containers and cleans up after a normal exit", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness();
    const runInput = input(root, projectRuntime);

    await collect(runner.run(runInput));

    expect(calls.map(({ command }) => command.slice(0, 3))).toEqual([
      ["docker", "rm", "-f"],
      ["docker", "build", "-f"],
      ["docker", "run", "--rm"],
      ["docker", "rm", "-f"],
    ]);
    expect(calls[0]?.command).toEqual(["docker", "rm", "-f", containerName(root)]);
    expect(calls[3]?.command).toEqual(calls[0]!.command);
    expect(calls[0]?.options.signal).not.toBe(runInput.signal);
    expect(calls[1]?.options.signal).toBe(runInput.signal);
    expect(calls[2]?.options.signal).toBe(runInput.signal);
    expect(calls[3]?.options.signal).not.toBe(runInput.signal);
  });

  test("cleans up when the container process fails", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      stream: (command) => {
        return command[1] === "run" ? rejectedEvents(new Error("container failed")) : [];
      },
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).rejects.toThrow(
      "container failed",
    );

    expect(calls.filter(({ command }) => command[1] === "rm")).toHaveLength(2);
  });

  test("cleans up when container execution is aborted", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const controller = new AbortController();
    const { calls, runner } = harness({
      stream: (command, options) => {
        if (command[1] === "run") {
          controller.abort();
          return rejectedEvents(options.signal?.reason);
        }
        return [];
      },
    });

    await expect(
      collect(runner.run(input(root, projectRuntime, controller.signal))),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls.filter(({ command }) => command[1] === "rm")).toHaveLength(2);
  });

  test("cleans up when the consumer stops iterating", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    let runIteratorClosed = false;
    const { calls, runner } = harness({
      stream: (command) => {
        if (command[1] !== "run") return [];
        return (async function* () {
          try {
            yield { type: "stdout", line: "container ready" } as const;
          } finally {
            runIteratorClosed = true;
          }
        })();
      },
    });
    const iterator = runner.run(input(root, projectRuntime));

    expect(await iterator.next()).toMatchObject({
      value: { type: "status", message: "Building image with docker" },
    });
    expect(await iterator.next()).toMatchObject({
      value: { type: "status", message: "Starting container" },
    });
    expect(await iterator.next()).toMatchObject({
      value: { type: "stdout", line: "container ready" },
    });
    await iterator.return(undefined);

    expect(runIteratorClosed).toBe(true);
    expect(calls.filter(({ command }) => command[1] === "rm")).toHaveLength(2);
  });

  test("ignores stale and final cleanup failures", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      stream: (command) => {
        return command[1] === "rm" ? rejectedEvents(new Error("container missing")) : [];
      },
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).resolves.toBeDefined();
    expect(commandCall(calls, "run")).toBeDefined();
    expect(calls.filter(({ command }) => command[1] === "rm")).toHaveLength(2);
  });

  test("does not run a container after a failed build", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      stream: (command) => {
        return command[1] === "build" ? rejectedEvents(new Error("build failed")) : [];
      },
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).rejects.toThrow("build failed");
    expect(calls.some(({ command }) => command[1] === "run")).toBe(false);
  });

  test("interleaves status, build output, and run output", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({
      stream: async function* (command) {
        if (command[1] === "build") yield { type: "stdout", line: "build output" };
        if (command[1] === "run") yield { type: "stderr", line: "run output" };
      },
    });

    const events = await collect(runner.run(input(root, projectRuntime)));

    expect(events).toEqual([
      { type: "status", message: "Building image with docker" },
      { type: "stdout", line: "build output" },
      { type: "status", message: "Starting container" },
      { type: "stderr", line: "run output" },
    ]);
  });
});
