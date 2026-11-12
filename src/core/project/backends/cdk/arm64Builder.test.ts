import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildxDriverWarning, checkArm64Builder } from "./arm64Builder";

describe("local container builder prerequisites", () => {
  const projects: string[] = [];
  const projectDirectory = () => {
    const path = mkdtempSync(join(tmpdir(), "agentcore-builder-test-"));
    projects.push(path);
    return path;
  };
  afterEach(() => {
    for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("accepts a native Linux ARM64 daemon without probing or creating builders", async () => {
    const commands: string[][] = [];
    await checkArm64Builder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.('{"OSType":"linux","Architecture":"aarch64"}');
      },
      "/project",
      "/tools/docker-wrapper",
    );
    // buildx is still inspected, for its driver, but nothing is built.
    expect(commands).toEqual([
      ["/tools/docker-wrapper", "info", "--format", "{{json .}}"],
      ["/tools/docker-wrapper", "buildx", "inspect"],
    ]);
  });
  test("accepts formatted daemon information alongside Finch stderr diagnostics", async () => {
    const commands: string[][] = [];
    await checkArm64Builder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.('time="now" level=warning msg="config {defaults}"\n');
        options.onOutput?.('{"OSType":"linux","Architecture":"arm64"}\n');
        options.onOutput?.('{"diagnostic":"after daemon output"}\n');
      },
      "/project",
      "finch",
    );
    expect(commands.map((command) => command[1])).toEqual(["info", "buildx"]);
  });

  test.each(["linux/arm64", "linux/arm64/v8", "linux/arm64*"])(
    "accepts advertised %s support without building or provisioning a builder",
    async (platform) => {
      const commands: string[][] = [];
      await checkArm64Builder(
        async (command, options) => {
          commands.push(command);
          options.onOutput?.(
            command[1] === "info"
              ? '{"OSType":"linux","Architecture":"x86_64"}'
              : `Platforms: linux/amd64*, ${platform}\n`,
          );
        },
        "/project",
        "docker",
      );
      expect(commands).toEqual([
        ["docker", "info", "--format", "{{json .}}"],
        ["docker", "buildx", "inspect"],
      ]);
    },
  );

  test.each(["unsupported buildx", "unadvertised ARM64", "failed buildx with partial output"])(
    "checks real ARM64 execution for a compatible builder with %s",
    async (capabilities) => {
      const commands: string[][] = [];
      const project = projectDirectory();
      let context = "";
      await checkArm64Builder(
        async (command, options) => {
          commands.push(command);
          if (command[1] === "info") {
            options.onOutput?.('{"OSType":"linux","Architecture":"x86_64"}');
          } else if (command[1] === "buildx") {
            if (capabilities === "unadvertised ARM64") {
              options.onOutput?.("Platforms: linux/amd64\n");
              return;
            }
            if (capabilities === "failed buildx with partial output") {
              options.onOutput?.("Platforms: linux/arm64\n");
            }
            throw new Error('unknown command "buildx"');
          } else if (command[1] === "build") {
            context = options.cwd;
            expect(context.startsWith(join(project, "agentcore", ".cli", "arm64-probe-"))).toBe(
              true,
            );
            expect(readFileSync(join(context, "Dockerfile"), "utf8")).toBe(
              'FROM scratch\nCOPY --chmod=0555 arm64-check /arm64-check\nRUN ["/arm64-check"]\n',
            );
            const executable = readFileSync(join(context, "arm64-check"));
            expect(executable.subarray(0, 4).toString("hex")).toBe("7f454c46");
            expect(executable.readUInt16LE(18)).toBe(183); // ELF machine: AArch64.
            expect(options.signal).toBeInstanceOf(AbortSignal);
            expect(existsSync(join(context, "output"))).toBe(true);
            writeFileSync(join(context, "output", "arm64-check"), executable);
          } else {
            throw new Error(`Unexpected builder command: ${command.join(" ")}`);
          }
        },
        project,
        "/tools/finch wrapper",
      );
      expect(commands[2]).toEqual([
        "/tools/finch wrapper",
        "build",
        "--platform",
        "linux/arm64",
        "--network",
        "none",
        "--no-cache",
        "--output",
        "type=local,dest=output",
        "--file",
        "Dockerfile",
        ".",
      ]);
      expect(existsSync(context)).toBe(false);
    },
  );

  test("refuses an unavailable daemon with an actionable error", async () => {
    await expect(
      checkArm64Builder(
        async () => {
          throw new Error("daemon denied");
        },
        "/project",
        "docker",
      ),
    ).rejects.toThrow("daemon or VM is running");
  });

  test("refuses an x86 builder without Linux ARM64 capability", async () => {
    const project = projectDirectory();
    let context = "";
    const buildError = new Error("exec format error");
    await expect(
      checkArm64Builder(
        async (command, options) => {
          if (command[1] === "build") {
            context = options.cwd;
            throw buildError;
          }
          options.onOutput?.(
            command[1] === "info"
              ? '{"OSType":"linux","Architecture":"x86_64"}'
              : "Platforms: linux/amd64\n",
          );
        },
        project,
        "docker",
      ),
    ).rejects.toThrow("cannot build Linux ARM64 images");
    expect(context).not.toBe("");
    expect(existsSync(context)).toBe(false);
  });

  test("reports a failed Finch build and cleans up its context", async () => {
    const project = projectDirectory();
    let context = "";
    const buildError = new Error("configured BuildKit is unavailable");
    let caught: unknown;
    try {
      await checkArm64Builder(
        async (command, options) => {
          if (command[1] === "info") {
            options.onOutput?.('{"OSType":"linux","Architecture":"x86_64"}');
          } else if (command[1] === "buildx") {
            throw new Error('unknown command "buildx"');
          } else {
            context = options.cwd;
            throw buildError;
          }
        },
        project,
        "finch",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("cannot build Linux ARM64 images");
    expect((caught as Error).message).toContain("binfmt");
    expect((caught as Error).cause).toBe(buildError);
    expect(context).not.toBe("");
    expect(existsSync(context)).toBe(false);
  });

  test("falls through to the later checks when daemon information is unreadable", async () => {
    const commands: string[][] = [];
    await checkArm64Builder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.(command[1] === "info" ? "not JSON" : "Platforms: linux/arm64\n");
      },
      "/project",
      "finch",
    );
    expect(commands.map((command) => command[1])).toEqual(["info", "buildx"]);
  });

  test("accepts a native ARM64 Podman host from its host.os/host.arch info", async () => {
    const commands: string[][] = [];
    await checkArm64Builder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.(JSON.stringify({ host: { os: "linux", arch: "arm64" } }));
      },
      "/project",
      "podman",
    );
    expect(commands).toEqual([["podman", "info", "--format", "{{json .}}"]]);
  });

  test("probes an x86 Podman host without calling buildx", async () => {
    const commands: string[][] = [];
    const project = projectDirectory();
    await checkArm64Builder(
      async (command, options) => {
        commands.push(command);
        if (command[1] === "info") {
          options.onOutput?.(JSON.stringify({ host: { os: "linux", arch: "amd64" } }));
        }
      },
      project,
      "/usr/bin/podman",
    );
    expect(commands.map((command) => command[1])).toEqual(["info", "build"]);
  });

  test("bounds the info and buildx queries with a timeout", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    await checkArm64Builder(
      async (command, options) => {
        signals.push(options.signal);
        options.onOutput?.(
          command[1] === "info"
            ? '{"OSType":"linux","Architecture":"x86_64"}'
            : "Platforms: linux/arm64\n",
        );
      },
      "/project",
      "docker",
    );
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("reports what it found when an x86 host cannot run ARM64", async () => {
    const project = projectDirectory();
    const error = await checkArm64Builder(
      async (command, options) => {
        if (command[1] === "info") {
          options.onOutput?.('{"OSType":"linux","Architecture":"x86_64"}');
        } else if (command[1] === "buildx") {
          options.onOutput?.(
            "Name:          multiarch-builder\nDriver:        docker-container\n" +
              "Nodes:\nName:      multiarch-builder0\nStatus:    inactive\nPlatforms:\n",
          );
        } else {
          options.onOutput?.("#5 [2/2] RUN /arm64-check\n");
          options.onOutput?.("exec /arm64-check: exec format error\n");
          throw new Error("exit code 1");
        }
      },
      project,
      "docker",
    ).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("daemon linux/x86_64");
    expect(message).toContain(
      "buildx builder 'multiarch-builder' (driver docker-container) does not list linux/arm64",
    );
    expect(message).toContain("ARM64 test build failed: exec format error");
    expect(message).toContain("binfmt");
  });

  test("reports the probe's last output line when the reason is not exec format error", async () => {
    const project = projectDirectory();
    const error = await checkArm64Builder(
      async (command, options) => {
        if (command[1] === "info") options.onOutput?.("not JSON");
        else if (command[1] === "buildx") throw new Error("unknown command");
        else {
          options.onOutput?.("starting\nbuildkit is not running\n");
          throw new Error("exit code 1");
        }
      },
      project,
      "finch",
    ).catch((caught: unknown) => caught as Error);
    const message = (error as Error).message;
    expect(message).toContain("daemon architecture unknown");
    expect(message).toContain("no buildx");
    expect(message).toContain("ARM64 test build failed: buildkit is not running");
  });

  test("reports the active buildx builder and its driver", async () => {
    const report = await checkArm64Builder(
      async (command, options) => {
        options.onOutput?.(
          command[1] === "info"
            ? '{"OSType":"linux","Architecture":"aarch64"}'
            : "Name:   multiarch-builder\nDriver: docker-container\nNodes:\nName: node0\n",
        );
      },
      "/project",
      "docker",
    );
    expect(report).toEqual({ buildx: { name: "multiarch-builder", driver: "docker-container" } });
  });
});

describe("buildxDriverWarning", () => {
  const containerDriver = { buildx: { name: "multiarch-builder", driver: "docker-container" } };
  test("warns about a non-docker driver and suggests the default builder", () => {
    const warning = buildxDriverWarning(containerDriver);
    expect(warning).toContain("'multiarch-builder'");
    expect(warning).toContain("docker-container");
    expect(warning).toContain("docker buildx use default");
  });
  test("stays quiet for the docker driver and without buildx", () => {
    expect(buildxDriverWarning({ buildx: { name: "default", driver: "docker" } })).toBeUndefined();
    expect(buildxDriverWarning({})).toBeUndefined();
  });
});
