import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRuntime } from "../../core/project/schema";
import type { StartDevServerInput, DevServerHandle } from "../../handlers/project/dev/types";
import { createSilentLogger } from "../../testing";
import { CodeZipDevRunner, parseEntrypoint, serverCommand } from "./codezip";

/** The schema brands entrypoint/codeLocation as FilePath/DirectoryPath; fixtures
 *  supply plain strings and cast through the brand in one place. */
function runtime(spec: {
  name: string;
  build: "CodeZip" | "Container";
  entrypoint: string;
  codeLocation: string;
}): ProjectRuntime {
  return spec as ProjectRuntime;
}

const pythonRuntime = runtime({
  name: "hello_world",
  build: "CodeZip",
  entrypoint: "main.py",
  codeLocation: "app/hello-world",
});

const tsRuntime = runtime({
  name: "hello_world",
  build: "CodeZip",
  entrypoint: "index.ts",
  codeLocation: "app/hello-world",
});

/** Accumulates run/spawn calls without executing anything real. */
function harness() {
  const commands: string[][] = [];
  const spawned: string[] = [];
  return {
    commands,
    spawned,
    run: async (cmd: string[]) => {
      commands.push(cmd);
    },
    supervisor: {
      spawn: (cmd: { executable: string; args: string[] }) => {
        spawned.push(cmd.executable);
        return {
          exited: Promise.resolve({ kind: "exited", code: 0 }),
          stop: () => Promise.resolve({ kind: "exited", code: 0 }),
        } as DevServerHandle;
      },
    },
  };
}

function startInput(
  root: string,
  h: ReturnType<typeof harness>,
  runtime: ProjectRuntime,
): StartDevServerInput {
  return {
    runtime,
    projectRoot: root,
    port: 8080,
    onLog: () => {},
  };
}

async function projectTree(root: string, codeDir: string) {
  await mkdir(join(root, codeDir), { recursive: true });
}

async function projectFile(root: string, codeDir: string, file: string, content = "") {
  await writeFile(join(root, codeDir, file), content);
}

describe("CodeZipDevRunner", () => {
  test("throws when code directory is missing", async () => {
    const h = harness();
    const runner = new CodeZipDevRunner({
      logger: createSilentLogger(),
      run: h.run,
      supervisor: h.supervisor as any,
    });
    const root = join(tmpdir(), `codezip-test-${Date.now()}`);
    await mkdir(root, { recursive: true });

    await expect(runner.start(startInput(root, h, pythonRuntime))).rejects.toThrow(
      /code directory not found/,
    );
    await rm(root, { recursive: true, force: true });
  });

  test("bootstraps venv via uv sync when uvicorn is not installed", async () => {
    const h = harness();
    const runner = new CodeZipDevRunner({
      logger: createSilentLogger(),
      run: h.run,
      supervisor: h.supervisor as any,
    });

    const root = join(tmpdir(), `codezip-test-${Date.now()}`);
    await projectTree(root, "app/hello-world");

    await runner.start(startInput(root, h, pythonRuntime));

    expect(h.commands).toEqual([["uv", "sync"]]);
    await rm(root, { recursive: true, force: true });
  });

  test("skips venv setup when uvicorn is already present", async () => {
    const h = harness();
    const runner = new CodeZipDevRunner({
      logger: createSilentLogger(),
      run: h.run,
      supervisor: h.supervisor as any,
    });

    const root = join(tmpdir(), `codezip-test-${Date.now()}`);
    await projectTree(root, "app/hello-world");
    // Simulate installed uvicorn.
    await mkdir(join(root, "app/hello-world/.venv/bin"), { recursive: true });
    await projectFile(root, "app/hello-world/.venv/bin", "uvicorn");

    await runner.start(startInput(root, h, pythonRuntime));

    expect(h.commands).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("spawns uvicorn with the entrypoint in ASGI form", async () => {
    const h = harness();
    const runner = new CodeZipDevRunner({
      logger: createSilentLogger(),
      run: h.run,
      supervisor: h.supervisor as any,
    });

    const root = join(tmpdir(), `codezip-test-${Date.now()}`);
    await projectTree(root, "app/hello-world");
    await mkdir(join(root, "app/hello-world/.venv/bin"), { recursive: true });
    await projectFile(root, "app/hello-world/.venv/bin", "uvicorn");

    await runner.start(
      startInput(root, h, runtime({ ...pythonRuntime, entrypoint: "main.py:application" })),
    );

    expect(h.spawned[0]).toContain("uvicorn");
    await rm(root, { recursive: true, force: true });
  });

  test("installs node_modules with npm for TypeScript runtime", async () => {
    const h = harness();
    const runner = new CodeZipDevRunner({
      logger: createSilentLogger(),
      run: h.run,
      supervisor: h.supervisor as any,
    });

    const root = join(tmpdir(), `codezip-test-${Date.now()}`);
    await projectTree(root, "app/hello-world");

    await runner.start(startInput(root, h, tsRuntime));

    expect(h.commands[0]?.[0]).toContain("npm");
    await rm(root, { recursive: true, force: true });
  });
});

describe("parseEntrypoint", () => {
  test.each([
    ["main.py", "main.py", "app", "python"],
    ["main.py:application", "main.py", "application", "python"],
    ["index.ts", "index.ts", "app", "typescript"],
    ["src/server.ts:handler", "src/server.ts", "handler", "typescript"],
  ] as const)("parses %s", (input, file, handler, language) => {
    expect(parseEntrypoint(input)).toEqual({ file, handler, language });
  });
});

describe("serverCommand", () => {
  test("builds uvicorn command for Python", () => {
    const cmd = serverCommand(
      { file: "main.py", handler: "app", language: "python" },
      "/project/app/hello",
      { runtime: pythonRuntime, projectRoot: "/project", port: 9000, onLog: () => {} },
    );

    expect(cmd.args).toContain("main:app");
    expect(cmd.args).toContain("--reload");
    expect(cmd.env.PORT).toBe("9000");
    expect(cmd.env.LOCAL_DEV).toBe("1");
  });

  test("builds tsx command for TypeScript", () => {
    const cmd = serverCommand(
      { file: "index.ts", handler: "app", language: "typescript" },
      "/project/app/hello",
      { runtime: tsRuntime, projectRoot: "/project", port: 9000, onLog: () => {} },
    );

    expect(cmd.args).toContain("tsx");
    expect(cmd.args).toContain("watch");
    expect(cmd.args).toContain("index.ts");
  });
});
