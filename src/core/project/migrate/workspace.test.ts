import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAssetSource } from "../source";
import { writeV0Project } from "./migrate-test-support";
import { buildMigrationWorkspace, diffTrees, removeOnInterrupt } from "./workspace";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("buildMigrationWorkspace", () => {
  test("builds the converted project beside the original, leaving the original untouched", async () => {
    const { root, cleanup } = await writeV0Project();
    cleanups.push(cleanup);
    const originalSpec = await readFile(join(root, "agentcore", "agentcore.json"), "utf8");

    const workspace = await buildMigrationWorkspace({
      rootPath: root,
      spec: { name: "CompatA", version: 2 },
      harnesses: [{ directory: "app/CompatAHarness", yaml: "name: CompatAHarness\n" }],
      assetSource: new FsAssetSource(),
    });
    cleanups.push(workspace.dispose);
    const ws = workspace.directory;

    expect(await readFile(join(ws, "agentcore", "agentcore.json"), "utf8")).toBe(
      `${JSON.stringify({ name: "CompatA", version: 2 }, null, 2)}\n`,
    );
    expect(existsSync(join(ws, "app", "CompatAHarness", "harness.json"))).toBe(false);
    expect(await readFile(join(ws, "app", "CompatAHarness", "harness.yaml"), "utf8")).toBe(
      "name: CompatAHarness\n",
    );
    expect(existsSync(join(ws, "app", "CompatAHarness", "system-prompt.md"))).toBe(true);
    // v1's vended CDK app replaces the v0 one, without dependencies or synth output.
    const vended = JSON.parse(await readFile(join(ws, "agentcore", "cdk", "package.json"), "utf8"));
    expect(Object.keys(vended.dependencies)).toContain("@aws/agentcore-cdk");
    expect(existsSync(join(ws, "agentcore", "cdk", ".gitignore"))).toBe(true);
    expect(existsSync(join(ws, "agentcore", "cdk", "jest.config.js"))).toBe(false);
    expect(existsSync(join(ws, "agentcore", "cdk", "node_modules"))).toBe(false);
    expect(existsSync(join(ws, "agentcore", "cdk", "cdk.out"))).toBe(false);
    // Ignored-but-needed project files come along.
    expect(existsSync(join(ws, "agentcore", ".cli", "deployed-state.json"))).toBe(true);

    expect(await readFile(join(root, "agentcore", "agentcore.json"), "utf8")).toBe(originalSpec);
    expect(existsSync(join(root, "app", "CompatAHarness", "harness.json"))).toBe(true);

    const byPath = Object.fromEntries(
      workspace.changes.map((change) => [change.path, change.kind]),
    );
    expect(byPath).toMatchObject({
      "agentcore/agentcore.json": "modified",
      "app/CompatAHarness/harness.json": "removed",
      "app/CompatAHarness/harness.yaml": "added",
      "agentcore/cdk/package.json": "modified",
      "agentcore/cdk/bin/cdk.ts": "modified",
      "agentcore/cdk/jest.config.js": "removed",
      "agentcore/cdk/lib/cdk-stack.ts": "modified",
    });
    expect(Object.keys(byPath).some((path) => path.includes("node_modules"))).toBe(false);
    expect(Object.keys(byPath).some((path) => path.includes("cdk.out"))).toBe(false);
    expect(byPath["app/CompatAAgent/main.py"]).toBeUndefined();
  });

  test("copies the deployed state and the vended app as they are", async () => {
    const { root, cleanup } = await writeV0Project();
    cleanups.push(cleanup);
    const statePath = join("agentcore", ".cli", "deployed-state.json");
    const originalState = await readFile(join(root, statePath), "utf8");

    const workspace = await buildMigrationWorkspace({
      rootPath: root,
      spec: { name: "CompatA", version: 2, migratedFrom: "v1" },
      harnesses: [],
      assetSource: new FsAssetSource(),
    });
    cleanups.push(workspace.dispose);

    // migratedFrom in agentcore.json keeps the names; deployed state isn't touched.
    expect(await readFile(join(workspace.directory, statePath), "utf8")).toBe(originalState);
    expect(workspace.changes).not.toContainEqual(
      expect.objectContaining({ path: "agentcore/.cli/deployed-state.json" }),
    );
    const app = await readFile(
      join(workspace.directory, "agentcore", "cdk", "bin", "cdk.ts"),
      "utf8",
    );
    expect(app).toBe(await readFile(join("src", "assets", "cdk", "bin", "cdk.ts"), "utf8"));
  });

  test("refuses to write through a symlink that leads out of the workspace", async () => {
    const { root, cleanup } = await writeV0Project();
    cleanups.push(cleanup);
    // The harness directory is a link to a directory outside the project. Copied as
    // is, the workspace's link still points there, so writing the converted harness
    // through it would change files outside the workspace.
    const outside = await mkdtemp(join(tmpdir(), "agentcore-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "harness.json"), "{}\n");
    await rm(join(root, "app", "CompatAHarness"), { recursive: true });
    await symlink(outside, join(root, "app", "CompatAHarness"), "junction");

    await expect(
      buildMigrationWorkspace({
        rootPath: root,
        spec: {},
        harnesses: [{ directory: "app/CompatAHarness", yaml: "name: x\n" }],
        assetSource: new FsAssetSource(),
      }),
    ).rejects.toThrow("resolves outside the migration workspace through a symlink");

    expect(await readFile(join(outside, "harness.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(outside, "harness.yaml"))).toBe(false);
  });

  test("leaves secrets, virtual environments, and caches out of the copy and the changes", async () => {
    const { root, cleanup } = await writeV0Project({
      files: {
        "agentcore/.env.local": "AGENTCORE_CREDENTIAL_KEY=secret\n",
        ".env": "X=1\n",
        "app/CompatAAgent/venv/bin/python": "x",
        "app/CompatAAgent/__pycache__/main.cpython-313.pyc": "x",
        "app/CompatAAgent/.pytest_cache/v/cache": "x",
      },
    });
    cleanups.push(cleanup);
    const workspace = await buildMigrationWorkspace({
      rootPath: root,
      spec: {},
      harnesses: [],
      assetSource: new FsAssetSource(),
    });
    cleanups.push(workspace.dispose);

    for (const path of [
      "agentcore/.env.local",
      ".env",
      "app/CompatAAgent/venv",
      "app/CompatAAgent/__pycache__",
      "app/CompatAAgent/.pytest_cache",
    ]) {
      expect({ path, copied: existsSync(join(workspace.directory, path)) }).toEqual({
        path,
        copied: false,
      });
    }
    const paths = workspace.changes.map((change) => change.path);
    expect(paths.some((path) => /\.env|venv|__pycache__|pytest_cache/.test(path))).toBe(false);
  });

  test("dispose removes the workspace", async () => {
    const { root, cleanup } = await writeV0Project();
    cleanups.push(cleanup);
    const workspace = await buildMigrationWorkspace({
      rootPath: root,
      spec: {},
      harnesses: [],
      assetSource: new FsAssetSource(),
    });
    await workspace.dispose();
    expect(existsSync(workspace.directory)).toBe(false);
  });
});

describe("diffTrees", () => {
  test("lists added, modified, and removed files in path order, skipping build output", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentcore-diff-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const write = async (path: string, content: string) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
    };
    const before = join(base, "before");
    const after = join(base, "after");
    await write(join(before, "same.txt"), "x");
    await write(join(after, "same.txt"), "x");
    await write(join(before, "b", "changed.txt"), "1");
    await write(join(after, "b", "changed.txt"), "2");
    await write(join(before, "gone.txt"), "x");
    await write(join(after, "a", "new.txt"), "x");
    await write(join(before, "agentcore", "cdk", "dist", "bin", "cdk.js"), "x");
    await write(join(before, "node_modules", "dep", "index.js"), "x");
    await write(join(before, "app", "agent", ".venv", "bin", "python"), "x");
    await write(join(after, ".git", "HEAD"), "x");

    expect(await diffTrees(before, after)).toEqual([
      { path: "a/new.txt", kind: "added" },
      { path: "b/changed.txt", kind: "modified" },
      { path: "gone.txt", kind: "removed" },
    ]);
  });
});

describe("removeOnInterrupt", () => {
  test("removes the directory on exit or interrupt until detached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-interrupt-"));
    const exitListeners = process.listenerCount("exit");
    const sigintListeners = process.listenerCount("SIGINT");

    const detach = removeOnInterrupt(directory);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);

    // Another SIGINT handler stays in charge of exiting, so invoking ours here only cleans up.
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);
    try {
      const onInterrupt = process.listeners("SIGINT").at(-2) as () => void;
      onInterrupt();
    } finally {
      process.off("SIGINT", keepAlive);
    }
    expect(existsSync(directory)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    detach();
  });

  test("also cleans up on SIGTERM and SIGHUP", async () => {
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "agentcore-interrupt-"));
      const before = process.listenerCount(signal);
      const detach = removeOnInterrupt(directory);
      expect(process.listenerCount(signal)).toBe(before + 1);
      const keepAlive = () => {};
      process.on(signal, keepAlive);
      try {
        (process.listeners(signal).at(-2) as () => void)();
      } finally {
        process.off(signal, keepAlive);
      }
      expect(existsSync(directory)).toBe(false);
      expect(process.listenerCount(signal)).toBe(before);
      detach();
    }
  });

  test("on Windows, ends with 128 + the signal number for a signal it can't raise (SIGHUP)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-interrupt-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const exit = process.exit;
    const kill = process.kill;
    const exits: (number | string | null | undefined)[] = [];
    const kills: unknown[] = [];
    Object.defineProperty(process, "platform", { value: "win32" });
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as typeof process.exit;
    process.kill = ((...args: unknown[]) => {
      kills.push(args[1]);
      return true;
    }) as typeof process.kill;
    // Other SIGHUP listeners (from the test runner) would take over the exit; set them aside.
    const others = process.listeners("SIGHUP");
    for (const listener of others) process.off("SIGHUP", listener);
    try {
      const detach = removeOnInterrupt(directory);
      (process.listeners("SIGHUP").at(-1) as () => void)();
      detach();
    } finally {
      for (const listener of others) process.on("SIGHUP", listener);
      Object.defineProperty(process, "platform", platform);
      process.exit = exit;
      process.kill = kill;
    }
    expect(existsSync(directory)).toBe(false);
    expect(exits).toEqual([129]);
  });
});
