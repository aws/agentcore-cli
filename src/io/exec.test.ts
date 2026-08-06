import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingToolError, ProcessFailedError } from "../errors";
import { requireTool, runProcess, toolAvailable } from "./exec";

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
