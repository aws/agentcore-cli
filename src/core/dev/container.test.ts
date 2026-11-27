import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  InputValidationError,
  InvalidEnvironmentError,
  ProjectStateError,
  ResourceNotFoundError,
} from "../../errors";
import type { DevEvent, DevServerInput } from "../../handlers/project/dev/types";
import {
  MissingToolError,
  type ProcessEvent,
  type ProcessStreamer,
  type StreamProcessOptions,
} from "../../io";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BOX_RELEASE } from "../project/backends/boxRelease";
import type { ResolveAwsCredentials } from "./boxAwsCredentials";
import { ContainerDevRunner } from "./container";

type ProcessCall = {
  command: string[];
  options: StreamProcessOptions;
  envFile?: { path: string; contents: string; mode: number };
  awsCredentials?: { path: string; contents: string; mode: number; folderMode: number };
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
    resolveAwsCredentials?: ResolveAwsCredentials;
    platform?: NodeJS.Platform;
  } = {},
) {
  const calls: ProcessCall[] = [];
  const fakeStreamProcess: ProcessStreamer = async function* (command, options) {
    const call: ProcessCall = { command, options };
    calls.push(call);
    const envFileFlag = command.indexOf("--env-file");
    if (envFileFlag >= 0) {
      const path = command[envFileFlag + 1]!;
      const [contents, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      call.envFile = { path, contents, mode: metadata.mode & 0o777 };
    }
    const awsMount = ":/aws-config/credentials:ro";
    const awsFlag = command.findIndex((part) => part.endsWith(awsMount));
    if (awsFlag >= 0) {
      // A Windows host path has its own colon (C:\...), so the host path ends at the mount.
      const path = command[awsFlag]!.slice(0, -awsMount.length);
      const [contents, file, folder] = await Promise.all([
        readFile(path, "utf8"),
        stat(path),
        stat(dirname(path)),
      ]);
      call.awsCredentials = {
        path,
        contents,
        mode: file.mode & 0o777,
        folderMode: folder.mode & 0o777,
      };
    }

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
      // Never the real chain in a test: none unless the test gives some.
      resolveAwsCredentials: config.resolveAwsCredentials ?? (async () => undefined),
      ...(config.platform && { platform: config.platform }),
    }),
  };
}

function input(
  root: string,
  projectRuntime: ProjectRuntime,
  signal = new AbortController().signal,
  boxProject = true,
): DevServerInput {
  return {
    runtime: projectRuntime,
    projectRoot: root,
    boxProject,
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

function commandCall(calls: ProcessCall[], operation: "build" | "run" | "stop"): ProcessCall {
  const call = calls.find(({ command }) => command[1] === operation);
  if (!call) throw new Error(`${operation} command was not called`);
  return call;
}

describe("ContainerDevRunner", () => {
  test("uses an absolute buildContextPath inside the project without prefixing it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-container-"));
    tempDirectories.push(root);
    await mkdir(join(root, "ctx"), { recursive: true });
    await writeFile(join(root, "ctx", "Dockerfile"), "FROM scratch\n");
    const { calls, runner } = harness();

    await collect(runner.run(input(root, runtime({ buildContextPath: join(root, "ctx") }))));

    expect(commandCall(calls, "build").options.cwd).toBe(join(root, "ctx"));
  });
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
    expect(build.options.env).toEqual({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
    });
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
      "--add-host",
      "host.docker.internal:host-gateway",
      "--env-file",
      run.envFile!.path,
      imageTag(root),
    ]);
    expect(run.options.env).toEqual({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
    });
    expect(parseEnv(run.envFile!.contents)).toEqual({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      API_KEY: "super-secret",
      PORT: String(containerPort),
      LOCAL_DEV: "1",
      ...(protocol === "MCP" ? { FASTMCP_PORT: "8000" } : {}),
    });
    if (process.platform !== "win32") expect(run.envFile!.mode).toBe(0o600);
    await expect(readFile(run.envFile!.path, "utf8")).rejects.toThrow();
    expect(run.command.join(" ")).not.toContain("super-secret");
    expect(run.command.join(" ")).not.toContain("test-secret-key");
  });

  test.each([
    ["a hook on its own port", 9300, 9301, ["-p", "127.0.0.1:9301:9300"]],
    ["a hook on the serving port", 8080, 9301, []],
    ["no host port for the hook", 9300, undefined, []],
  ] as const)(
    "publishes a warmup hook port only for %s",
    async (_label, hookPort, hostPort, extra) => {
      const projectRuntime = runtime({
        hooksConfiguration: {
          build: { warmup: { action: { httpPost: { path: "/warmup", port: hookPort } } } },
        },
      } as RuntimeOverrides);
      const root = await projectRoot(projectRuntime);
      const { calls, runner } = harness();

      await collect(
        runner.run({
          ...input(root, projectRuntime),
          ...(hostPort !== undefined && { hookPort: hostPort }),
        }),
      );

      const run = commandCall(calls, "run");
      expect(run.command.slice(5, 7 + extra.length)).toEqual([
        "-p",
        "127.0.0.1:3000:8080",
        ...extra,
      ]);
    },
  );

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
    expect(run.command).not.toContain("AWS_PROFILE");
    expect(run.command).not.toContain("AWS_CONFIG_FILE");
    expect(parseEnv(run.envFile!.contents)).toMatchObject({
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

  test("keeps app variables out of the container CLI control environment", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness();
    const runInput = input(root, projectRuntime);
    runInput.env = { ...runInput.env, DOCKER_HOST: "tcp://application-value" };

    await collect(runner.run(runInput));

    const run = commandCall(calls, "run");
    expect(run.command).not.toContain("DOCKER_HOST");
    expect(run.command.join(" ")).not.toContain("tcp://application-value");
    expect(run.options.env?.DOCKER_HOST).toBeUndefined();
    expect(parseEnv(run.envFile!.contents).DOCKER_HOST).toBe("tcp://application-value");
  });

  test("uses the tool AGENTCORE_CONTAINER_TOOL names, even when an earlier one can build", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      available: async () => true,
      processEnv: {
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AGENTCORE_CONTAINER_TOOL: "finch",
      },
    });

    await collect(runner.run(input(root, projectRuntime)));

    expect(commandCall(calls, "build").command[0]).toBe("finch");
    expect(commandCall(calls, "run").command[0]).toBe("finch");
  });

  test("refuses an AGENTCORE_CONTAINER_TOOL it does not know", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({
      processEnv: {
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AGENTCORE_CONTAINER_TOOL: "nerdctl",
      },
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).rejects.toBeInstanceOf(
      InputValidationError,
    );
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

    await expect(promise).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(promise).rejects.toThrow(/no container build context directory exists at/);
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

    await expect(promise).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(promise).rejects.toThrow(/no container Dockerfile exists at/);
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
      ["docker", "stop", "-t"],
    ]);
    expect(calls[0]?.command).toEqual(["docker", "rm", "-f", containerName(root)]);
    // At shutdown the container gets a 2s grace period, then `run --rm` removes it.
    expect(calls[3]?.command).toEqual(["docker", "stop", "-t", "2", containerName(root)]);
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

    expect(commandCall(calls, "stop")).toBeDefined();
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

    expect(commandCall(calls, "stop")).toBeDefined();
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
    expect(commandCall(calls, "stop")).toBeDefined();
  });

  test("warns how to remove the container when stop fails at shutdown", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      stream: (command) =>
        command[1] === "stop" ? rejectedEvents(new Error("daemon is slow")) : [],
    });

    const events = await collect(runner.run(input(root, projectRuntime)));

    const warning = events.find(
      (event) => event.type === "status" && event.message.startsWith("Could not stop"),
    );
    expect(warning).toMatchObject({
      message: expect.stringContaining(`'docker rm -f ${containerName(root)}'`),
    });
    expect(calls.at(-1)?.command[1]).toBe("stop");
  });

  test("keeps the run's own error when stop fails too", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({
      stream: (command) =>
        command[1] === "run" || command[1] === "stop"
          ? rejectedEvents(new Error(`${command[1]} failed`))
          : [],
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).rejects.toThrow("run failed");
  });

  test("treats a container that already exited as stopped", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { runner } = harness({
      stream: (command) =>
        command[1] === "stop"
          ? rejectedEvents(new Error("Error response from daemon: No such container: x"))
          : [],
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).resolves.toBeDefined();
  });

  test("ignores a failed removal of a stale container", async () => {
    const projectRuntime = runtime();
    const root = await projectRoot(projectRuntime);
    const { calls, runner } = harness({
      stream: (command) => {
        return command[1] === "rm" ? rejectedEvents(new Error("container missing")) : [];
      },
    });

    await expect(collect(runner.run(input(root, projectRuntime)))).resolves.toBeDefined();
    expect(commandCall(calls, "run")).toBeDefined();
    expect(calls.filter(({ command }) => command[1] === "rm")).toHaveLength(1);
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

  describe("with a box image", () => {
    const BOX_DOCKERFILE = "FROM scratch\nCOPY .box-dist/profile.toml /opt/box/\n";

    /** A project named `Demo` whose Dockerfile copies .box-dist/. */
    async function boxedScene(
      options: {
        profile?: boolean;
        /** The text of `.box/Hello_World/local/profile.toml`. */
        profileText?: string;
        dockerfile?: string;
        /** Whether the runtime has box.version, which create writes only for a box template. */
        box?: boolean;
      } = {},
    ) {
      const projectRuntime = runtime(options.box === false ? {} : { box: { version: "1.0.0" } });
      const root = await projectRoot(projectRuntime);
      const context = join(root, projectRuntime.codeLocation);
      await writeFile(join(context, "Dockerfile"), options.dockerfile ?? BOX_DOCKERFILE);
      await mkdir(join(root, "agentcore"));
      await writeFile(join(root, "agentcore", "agentcore.json"), '{"name":"Demo"}');
      if (options.profile ?? true) {
        const local = join(root, ".box", projectRuntime.name, "local");
        await mkdir(local, { recursive: true });
        await writeFile(join(local, "profile.toml"), options.profileText ?? "# local profile\n");
      }
      return { projectRuntime, root, context };
    }

    const credentials = {
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
    };

    test("says where it staged box", async () => {
      const { projectRuntime, root, context } = await boxedScene();
      const { runner } = harness({ processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(events).toContainEqual({
        type: "status",
        message: `Staged box for the image in ${join(context, ".box-dist")}`,
      });
    });

    test("runs a runtime with no box.version without box, whatever its Dockerfile says", async () => {
      const { projectRuntime, root, context } = await boxedScene({
        dockerfile: "FROM scratch\n# TODO: COPY .box-dist/ later\n",
        box: false,
      });
      const { calls, runner } = harness({ processEnv: credentials });

      await collect(runner.run(input(root, projectRuntime)));

      expect(await readdir(context)).not.toContain(".box-dist");
      expect(commandCall(calls, "run").command).not.toContain("--cap-add");
    });

    test("stages the runtime's own box profile, not the profile of another runtime", async () => {
      const { projectRuntime, root, context } = await boxedScene();
      await mkdir(join(root, ".box", "other", "local"), { recursive: true });
      await writeFile(join(root, ".box", "other", "local", "profile.toml"), "# other\n");
      const { runner } = harness({ processEnv: credentials });

      await collect(runner.run(input(root, projectRuntime)));

      expect(await readFile(join(context, ".box-dist", "profile.toml"), "utf8")).toBe(
        "# local profile\n",
      );
    });

    test("with dev's collector on, stages a profile that sends traces and box's records to it", async () => {
      const local =
        '[profile]\nname = "Demo-agent"\n\n' +
        '[agent]\ncommand = ["${{ workspace }}/.venv/bin/python", "-m", "uvicorn", "main:app", "--reload", "--port", "8081"]\n';
      const { projectRuntime, root, context } = await boxedScene({ profileText: local });
      const { runner } = harness({ processEnv: credentials });
      const traced = {
        ...input(root, projectRuntime),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:4318" },
      };

      const events = await collect(runner.run(traced));

      const staged = parseToml(
        await readFile(join(context, ".box-dist", "profile.toml"), "utf8"),
      ) as {
        profile: { name: string };
        telemetry: Record<string, { kind: string; destination: string }>;
        agent: { command: string[]; env: Record<string, string> };
      };
      // Box runs in the container, with its own box home, so the profile keeps its name.
      expect(staged.profile.name).toBe("Demo-agent");
      expect(staged.telemetry.agentcore_dev!.destination).toBe("http://host.docker.internal:4318");
      expect(staged.agent.command).toEqual([
        "${{ workspace }}/.venv/bin/opentelemetry-instrument",
        "${{ workspace }}/.venv/bin/python",
        "-m",
        "uvicorn",
        "main:app",
        "--port",
        "8081",
      ]);
      expect(staged.agent.env.OTEL_SERVICE_NAME).toBe(projectRuntime.name);
      expect(events).toContainEqual({
        type: "status",
        message: "Traces of the agent and box's records go to the dev collector",
      });
      // The committed profile is unchanged.
      expect(
        await readFile(join(root, ".box", projectRuntime.name, "local", "profile.toml"), "utf8"),
      ).toBe(local);
    });

    test("with dev's collector on, says that only box's records go to it when the command is not the venv's Python", async () => {
      const local = '[agent]\ncommand = ["node", "server.js"]\n';
      const { projectRuntime, root, context } = await boxedScene({ profileText: local });
      const { runner } = harness({ processEnv: credentials });
      const traced = {
        ...input(root, projectRuntime),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:4318" },
      };

      const events = await collect(runner.run(traced));

      expect(events).toContainEqual({
        type: "status",
        message:
          "Box's records go to the dev collector. The agent's own spans do not, because its command is not the venv's Python",
      });
      const staged = parseToml(
        await readFile(join(context, ".box-dist", "profile.toml"), "utf8"),
      ) as {
        telemetry: Record<string, { destination: string }>;
        agent: { command: string[] };
      };
      expect(staged.telemetry.agentcore_dev!.destination).toBe("http://host.docker.internal:4318");
      expect(staged.agent.command).toEqual(["node", "server.js"]);
    });

    test("stages the local profile as it is when the runtime turns observability off", async () => {
      const { projectRuntime, root, context } = await boxedScene();
      const { runner } = harness({ processEnv: credentials });
      const off = {
        ...input(root, {
          ...projectRuntime,
          envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }],
        }),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:4318" },
      };

      await collect(runner.run(off));

      expect(await readFile(join(context, ".box-dist", "profile.toml"), "utf8")).toBe(
        "# local profile\n",
      );
    });

    test("stages the local profile in .box-dist/, and lets box's sandbox run", async () => {
      const { projectRuntime, root, context } = await boxedScene();
      const { calls, runner } = harness({ processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(events).toContainEqual({
        type: "status",
        message: `Staged box for the image in ${join(context, ".box-dist")}`,
      });
      // The Dockerfile copies .box-dist/, so the build takes no extra build context.
      expect(commandCall(calls, "build").command).toEqual([
        "docker",
        "build",
        "-f",
        "Dockerfile",
        "-t",
        imageTag(root),
        ".",
      ]);
      // The box release the image downloads, and the local profile.
      expect((await readdir(join(context, ".box-dist"))).sort()).toEqual([
        "box-release.env",
        "profile.toml",
      ]);
      expect(await readFile(join(context, ".box-dist", "profile.toml"), "utf8")).toBe(
        "# local profile\n",
      );
      const run = commandCall(calls, "run").command;
      expect(run.slice(run.indexOf("--cap-add"), run.indexOf("--cap-add") + 8)).toEqual([
        "--cap-add",
        "SYS_ADMIN",
        "--security-opt",
        "seccomp=unconfined",
        "--security-opt",
        "apparmor=unconfined",
        "--security-opt",
        "systempaths=unconfined",
      ]);
    });

    test("stages a BOX_DIST image in .box-dev/, leaving build and deploy's .box-dist/ alone", async () => {
      const { projectRuntime, root, context } = await boxedScene({
        dockerfile: "FROM scratch\nARG BOX_DIST=.box-dist\nCOPY ${BOX_DIST}/ /opt/box/\n",
      });
      await mkdir(join(context, ".box-dist"));
      await writeFile(join(context, ".box-dist", "profile.toml"), "# runtime profile\n");
      let staged: string | undefined;
      const { calls, runner } = harness({
        processEnv: credentials,
        stream: async function* (command) {
          // What docker build sees: dev's folder, while it builds.
          if (command[1] === "build") {
            staged = await readFile(join(context, ".box-dev", "profile.toml"), "utf8");
          }
          yield* [];
        },
      });

      await collect(runner.run(input(root, projectRuntime)));

      expect(commandCall(calls, "build").command).toEqual([
        "docker",
        "build",
        "-f",
        "Dockerfile",
        "-t",
        imageTag(root),
        "--build-arg",
        "BOX_DIST=.box-dev",
        ".",
      ]);
      expect(staged).toBe("# local profile\n");
      // Removed once built, so no deploy uploads dev's profile.
      expect(existsSync(join(context, ".box-dev"))).toBe(false);
      expect(await readFile(join(context, ".box-dist", "profile.toml"), "utf8")).toBe(
        "# runtime profile\n",
      );
      expect(commandCall(calls, "run").command).toContain("--cap-add");
    });

    test("removes .box-dev/ when the image build fails", async () => {
      const { projectRuntime, root, context } = await boxedScene({
        dockerfile: "FROM scratch\nARG BOX_DIST=.box-dist\nCOPY ${BOX_DIST}/ /opt/box/\n",
      });
      const { runner } = harness({
        processEnv: credentials,
        stream: (command) =>
          command[1] === "build"
            ? rejectedEvents(new Error("build failed"))
            : (async function* () {})(),
      });

      await expect(collect(runner.run(input(root, projectRuntime)))).rejects.toThrow(
        "build failed",
      );

      expect(existsSync(join(context, ".box-dev"))).toBe(false);
    });

    test('refuses an image that installs box when agentcore.json has no "projectType": "box"', async () => {
      const { projectRuntime, root, context } = await boxedScene();
      const { calls, runner } = harness({ processEnv: credentials });

      const error = await collect(
        runner.run(input(root, projectRuntime, undefined, /* boxProject */ false)),
      ).catch((caught) => caught);

      expect(error).toBeInstanceOf(ProjectStateError);
      expect((error as Error).message).toContain(
        'runs its agent in a box (it has box.version), but agentcore.json has no "projectType": "box"',
      );
      expect(calls.map(({ command }) => command[1])).not.toContain("build");
      expect(calls.map(({ command }) => command[1])).not.toContain("run");
      expect(existsSync(join(context, ".box-dist"))).toBe(false);
    });

    test("hands box in the container the profile's env:// key from the shell, through the run's env file", async () => {
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
      });
      const { calls, runner } = harness({
        processEnv: { ...credentials, GITHUB_TOKEN: "ghp_shell", UNRELATED: "x" },
      });

      await collect(runner.run(input(root, projectRuntime)));

      const run = commandCall(calls, "run");
      const forwarded = parseEnv(run.envFile!.contents);
      expect(forwarded.GITHUB_TOKEN).toBe("ghp_shell");
      // Only the keys the profile names, not the rest of the shell.
      expect(forwarded.UNRELATED).toBeUndefined();
      // Passed through the env file, never on the command line, and written to no .env.local.
      expect(run.command.join(" ")).not.toContain("ghp_shell");
      expect(existsSync(join(root, "agentcore", ".env.local"))).toBe(false);
    });

    test("hands box in the container a telemetry target's secret:// key from the shell", async () => {
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[telemetry.langsmith]\nkind = "langsmith"\nsecret.ref = "secret://LANGSMITH_KEY"\n',
      });
      const { calls, runner } = harness({
        processEnv: { ...credentials, LANGSMITH_KEY: "dummy-langsmith-key" },
      });

      await collect(runner.run(input(root, projectRuntime)));

      const run = commandCall(calls, "run");
      expect(parseEnv(run.envFile!.contents).LANGSMITH_KEY).toBe("dummy-langsmith-key");
      expect(run.command.join(" ")).not.toContain("dummy-langsmith-key");
    });

    test("hands box in the container the shell's env:// key over .env.local's", async () => {
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
      });
      const { calls, runner } = harness({
        processEnv: { ...credentials, GITHUB_TOKEN: "ghp_shell" },
      });
      // input.env is what dev read from agentcore/.env.local.
      const fromFile = input(root, projectRuntime);

      await collect(runner.run({ ...fromFile, env: { GITHUB_TOKEN: "ghp_file" } }));

      expect(parseEnv(commandCall(calls, "run").envFile!.contents).GITHUB_TOKEN).toBe("ghp_shell");
    });

    test("warns when the profile's env:// key is not set, before the container's box reports it", async () => {
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
      });
      const { calls, runner } = harness({ processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(events).toContainEqual({
        type: "status",
        message: expect.stringContaining(
          "reads GITHUB_TOKEN for [egress.github], but it is not set",
        ),
      });
      expect(commandCall(calls, "run")).toBeDefined();
    });

    test("warns before the image build, as the lookup needs only the profile and the env", async () => {
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
      });
      const { runner } = harness({ processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));
      const messages = events.map((event) => ("message" in event ? event.message : ""));

      const warning = messages.findIndex((message) => message.includes("reads GITHUB_TOKEN"));
      const build = messages.findIndex((message) => message.startsWith("Building image with"));
      expect(warning).toBeGreaterThanOrEqual(0);
      expect(warning).toBeLessThan(build);
    });

    test("hands the container a Windows shell's variable in another case, under its name", async () => {
      // process.env is case-insensitive on Windows, so an exported Github_Token sets GITHUB_TOKEN.
      const { projectRuntime, root } = await boxedScene({
        profileText:
          '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
      });
      const { calls, runner } = harness({
        processEnv: { ...credentials, Github_Token: "ghp_win" },
        platform: "win32",
      });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(parseEnv(commandCall(calls, "run").envFile!.contents).GITHUB_TOKEN).toBe("ghp_win");
      expect(JSON.stringify(events)).not.toContain("reads GITHUB_TOKEN for [egress.github]");
    });

    test("stages the pinned box, whatever box.version the runtime names", async () => {
      const { projectRuntime, root, context } = await boxedScene();
      const { runner } = harness({ processEnv: credentials });

      await collect(runner.run(input(root, { ...projectRuntime, box: { version: "2.0.0" } })));

      const env = await readFile(join(context, ".box-dist", "box-release.env"), "utf8");
      expect(env).toContain(BOX_RELEASE.version);
      expect(env).not.toContain("2.0.0");
    });

    test("runs a runtime with no box.version without box's flags, even with a box profile", async () => {
      const { projectRuntime, root, context } = await boxedScene({
        dockerfile: "FROM scratch\n",
        box: false,
      });
      const { calls, runner } = harness({ processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(commandCall(calls, "run").command).not.toContain("--cap-add");
      expect(existsSync(join(context, ".box-dist"))).toBe(false);
      expect(
        events.some((event) => event.type === "status" && event.message.startsWith("Staged box")),
      ).toBe(false);
    });

    test("stages each policy file the profile names beside it in .box-dist/", async () => {
      const { projectRuntime, root, context } = await boxedScene({
        profileText: 'policies = ["policy.dw", "rules/extra.dw"]\n',
      });
      const local = join(root, ".box", projectRuntime.name, "local");
      await mkdir(join(local, "rules"));
      await writeFile(join(local, "policy.dw"), "// rules\n");
      await writeFile(join(local, "rules", "extra.dw"), "// extra\n");
      const { runner } = harness({ processEnv: credentials });

      await collect(runner.run(input(root, projectRuntime)));

      expect(await readFile(join(context, ".box-dist", "policy.dw"), "utf8")).toBe("// rules\n");
      expect(await readFile(join(context, ".box-dist", "rules", "extra.dw"), "utf8")).toBe(
        "// extra\n",
      );
    });

    test.each([
      [
        "a TOML error",
        'policies = ["policy.dw"]\n[agent\n',
        ".box/Hello_World/local/profile.toml:2:7  This is not valid TOML (illegal character in " +
          "key). Correct the syntax.",
      ],
      [
        "the `policy` key",
        '# one file\npolicy = "policy.dw"\n',
        ".box/Hello_World/local/profile.toml:2:1  Box does not take the key `policy`. List your " +
          'policy files under `policies` instead, such as policies = ["policy.dw"].',
      ],
      [
        "a policy file outside .box/Hello_World/local/",
        'policies = ["../../elsewhere.dw"]\n',
        '.box/Hello_World/local/profile.toml:1:1  `policies` names "../../elsewhere.dw", which is ' +
          "outside .box/Hello_World/local/. Move the file into .box/Hello_World/local/, and name it " +
          "from there.",
      ],
    ])("stops, and stages nothing, for a profile with %s", async (_, profileText, line) => {
      const { projectRuntime, root, context } = await boxedScene({ profileText });
      const { calls, runner } = harness({ processEnv: credentials });

      const error = await collect(runner.run(input(root, projectRuntime))).catch(
        (caught) => caught,
      );

      expect(error).toBeInstanceOf(ProjectStateError);
      expect((error as Error).message).toBe(
        `Dev stopped: 1 problem in the Box profile. Dev wrote nothing from the Box profile.\n${line}`,
      );
      expect(existsSync(join(context, ".box-dist"))).toBe(false);
      expect(calls.filter(({ command }) => command[1] === "build")).toEqual([]);
    });

    test("passes box a readable copy of the resolved credentials as profile default", async () => {
      const { projectRuntime, root } = await boxedScene();
      const awsDirectory = join(root, ".aws");
      await mkdir(awsDirectory);
      const { calls, runner } = harness({
        awsDirectory,
        processEnv: { AWS_PROFILE: "sandbox", AWS_REGION: "us-west-2" },
        resolveAwsCredentials: async () => ({
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "secret-example",
          sessionToken: "token-example",
        }),
      });

      await collect(runner.run(input(root, projectRuntime)));

      const run = commandCall(calls, "run");
      // Not ~/.aws, which the image's user cannot read when only you may.
      expect(run.command.join(" ")).not.toContain(`${awsDirectory}:/aws-config`);
      expect(run.command.some((part) => part.endsWith(":/aws-config/config:ro"))).toBe(true);
      expect(run.awsCredentials).toMatchObject({
        contents:
          "[default]\naws_access_key_id = AKIDEXAMPLE\naws_secret_access_key = secret-example\n" +
          "aws_session_token = token-example\n",
        // Readable by the container's user; the folder keeps other host users out. Windows has no
        // mode bits.
        ...(process.platform !== "win32" && { mode: 0o644, folderMode: 0o700 }),
      });
      const env = parseEnv(run.envFile!.contents);
      expect(env).toMatchObject({
        AWS_CONFIG_FILE: "/aws-config/config",
        AWS_SHARED_CREDENTIALS_FILE: "/aws-config/credentials",
        AWS_REGION: "us-west-2",
      });
      // The files hold only [default].
      expect(env.AWS_PROFILE).toBeUndefined();
      expect(existsSync(run.awsCredentials!.path)).toBe(false);
    });

    test("mounts ~/.aws for a box image when no credentials resolve", async () => {
      const { projectRuntime, root } = await boxedScene();
      const awsDirectory = join(root, ".aws");
      await mkdir(awsDirectory);
      const { calls, runner } = harness({ awsDirectory, processEnv: credentials });

      const events = await collect(runner.run(input(root, projectRuntime)));

      expect(commandCall(calls, "run").command).toContain(`${awsDirectory}:/aws-config:ro`);
      expect(events).toContainEqual({
        type: "status",
        message: expect.stringContaining("No AWS credentials resolved for box"),
      });
    });

    test("removes the credentials folder when the consumer stops at its status line", async () => {
      const { projectRuntime, root } = await boxedScene();
      const { calls, runner } = harness({
        processEnv: credentials,
        resolveAwsCredentials: async () => ({
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "secret-example",
        }),
      });
      const iterator = runner.run(input(root, projectRuntime));
      let next = await iterator.next();
      while (!next.done && !("message" in next.value && next.value.message.startsWith("Passing"))) {
        next = await iterator.next();
      }
      expect(next.done).toBe(false);
      await iterator.return(undefined);

      // The cleanup ran, which removes the credentials folder too, though the container never ran.
      expect(commandCall(calls, "stop")).toBeDefined();
      expect(calls.some(({ command }) => command[1] === "run")).toBe(false);
    });

    test("leaves an image without box on ~/.aws, without resolving credentials", async () => {
      const { projectRuntime, root } = await boxedScene({
        dockerfile: "FROM scratch\n",
        box: false,
      });
      const awsDirectory = join(root, ".aws");
      await mkdir(awsDirectory);
      let resolved = 0;
      const { calls, runner } = harness({
        awsDirectory,
        processEnv: credentials,
        resolveAwsCredentials: async () => {
          resolved += 1;
          return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" };
        },
      });

      await collect(runner.run(input(root, projectRuntime)));

      expect(resolved).toBe(0);
      expect(commandCall(calls, "run").command).toContain(`${awsDirectory}:/aws-config:ro`);
    });

    test("refuses a box image when the project has no box profile", async () => {
      const { projectRuntime, root } = await boxedScene({ profile: false });
      const { calls, runner } = harness({ processEnv: credentials });

      const error = await collect(runner.run(input(root, projectRuntime))).catch(
        (caught) => caught,
      );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as Error).message).toContain("it has box.version in agentcore.json");
      expect(calls.filter(({ command }) => command[1] === "build")).toEqual([]);
    });
  });
});
