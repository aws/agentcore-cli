import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MissingToolError,
  ProcessFailedError,
  requireTool,
  runProcess,
  streamProcess,
  toolAvailable,
  type ProcessEvent,
} from "./exec";

// Scripts run from files rather than `node -e` one-liners: on win32 runProcess
// spawns through cmd.exe (for PATHEXT resolution), which mangles quoted args.
const scriptsDir = await mkdtemp(join(tmpdir(), "agentcore-exec-"));
async function script(name: string, source: string): Promise<string> {
  const path = join(scriptsDir, name);
  await writeFile(path, source);
  return path;
}

afterAll(() => rm(scriptsDir, { recursive: true, force: true }));

describe("toolAvailable", () => {
  test("finds a tool that exists", async () => {
    // node is guaranteed present: it's running this test suite's runtime deps.
    expect(await toolAvailable("node")).toBe(true);
  });

  test("misses a tool that does not exist", async () => {
    expect(await toolAvailable("definitely-not-a-real-tool-xyz")).toBe(false);
  });
});

describe("requireTool", () => {
  test("passes for an available tool", async () => {
    await expect(requireTool("node", "unused hint")).resolves.toBeUndefined();
  });

  test("throws MissingToolError with the install hint", async () => {
    await expect(
      requireTool("definitely-not-a-real-tool-xyz", "Install it from https://example.com"),
    ).rejects.toThrow(
      new MissingToolError("definitely-not-a-real-tool-xyz", "Install it from https://example.com"),
    );
  });
});

describe("runProcess", () => {
  test("resolves on exit 0 and streams output to onOutput", async () => {
    const succeeding = await script("succeed.js", "console.log('hello')");
    const chunks: string[] = [];
    await runProcess(["node", succeeding], {
      cwd: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("hello");
  });

  test("rejects with ProcessFailedError carrying output and exit code", async () => {
    const failing = await script("fail.js", "console.error('boom'); process.exit(3)");
    const promise = runProcess(["node", failing], { cwd: process.cwd() });

    await expect(promise).rejects.toBeInstanceOf(ProcessFailedError);
    await expect(promise).rejects.toThrow(/exit code 3/);
    await expect(promise).rejects.toThrow(/boom/);
  });

  test("rejects with ProcessFailedError when the executable cannot spawn", async () => {
    await expect(
      runProcess(["definitely-not-a-real-tool-xyz"], { cwd: process.cwd() }),
    ).rejects.toBeInstanceOf(ProcessFailedError);
  });
});

async function collect(events: AsyncIterable<ProcessEvent>): Promise<ProcessEvent[]> {
  const collected: ProcessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("streamProcess", () => {
  test("yields complete lines with their source stream", async () => {
    const streaming = await script(
      "stream.js",
      "console.log('one'); console.log('two'); console.error('0 errors')",
    );

    const events = await collect(streamProcess(["node", streaming], { cwd: process.cwd() }));

    expect(events).toContainEqual({ type: "stdout", line: "one" });
    expect(events).toContainEqual({ type: "stdout", line: "two" });
    expect(events).toContainEqual({ type: "stderr", line: "0 errors" });
  });

  test("throws ProcessFailedError after yielding failure output", async () => {
    if (process.platform === "win32") return;

    const failing = await script("stream-fail.js", "console.error('boom'); process.exit(3)");
    const iterator = streamProcess(["node", failing], { cwd: process.cwd() });

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "stderr", line: "boom" },
    });
    await expect(iterator.next()).rejects.toThrow(/exit code 3/);
  });

  test("redacts sensitive command arguments from process errors", async () => {
    const failing = await script("stream-redacted-fail.js", "process.exit(3)");
    const iterator = streamProcess(["node", failing, "super-secret"], {
      cwd: process.cwd(),
      redactedCommand: ["node", failing, "<redacted>"],
    });

    const error = await iterator.next().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProcessFailedError);
    expect(String(error)).toContain("<redacted>");
    expect(String(error)).not.toContain("super-secret");
  });

  test("throws ProcessFailedError when the executable cannot spawn", async () => {
    await expect(
      collect(streamProcess(["definitely-not-a-real-tool-xyz"], { cwd: process.cwd() })),
    ).rejects.toBeInstanceOf(ProcessFailedError);
  });

  test("aborts a running process", async () => {
    if (process.platform === "win32") return;

    const running = await script("running.js", "console.log('ready'); setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const iterator = streamProcess(["node", running], {
      cwd: process.cwd(),
      signal: controller.signal,
    });

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "stdout", line: "ready" },
    });
    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  test("stops the process when iteration ends early", async () => {
    if (process.platform === "win32") return;

    const running = await script(
      "return.js",
      "console.log('ready'); setInterval(() => console.log('tick'), 1000)",
    );
    const iterator = streamProcess(["node", running], { cwd: process.cwd() });

    expect((await iterator.next()).value).toEqual({ type: "stdout", line: "ready" });
    await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined });
  });

  test("kills descendants that outlive the direct child", async () => {
    if (process.platform === "win32") return;

    const parent = await script(
      "process-tree.js",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "console.log(child.pid);",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const controller = new AbortController();
    const iterator = streamProcess(["node", parent], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    const first = await iterator.next();
    const descendantPid = Number(first.value?.line);

    try {
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
      expect(await processStopped(descendantPid)).toBe(true);
    } finally {
      if (processRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  });

  test("kills descendants when the parent exits first", async () => {
    if (process.platform === "win32") return;

    const parent = await script(
      "parent-exits.js",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "child.unref();",
        "console.log(child.pid);",
      ].join("\n"),
    );
    const events = await collect(streamProcess(["node", parent], { cwd: process.cwd() }));
    const descendantPid = Number(events.find((event) => event.type === "stdout")?.line);

    try {
      expect(await processStopped(descendantPid)).toBe(true);
    } finally {
      if (processRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  });
});

async function processStopped(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processRunning(pid)) return true;
    await delay(10);
  }
  return false;
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Linux reports kill(pid, 0) success for zombies that cannot execute.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}
