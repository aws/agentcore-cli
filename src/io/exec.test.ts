import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailedError, MissingToolError, requireTool, runCommand, toolOnPath } from "./exec";

// Scripts run from files rather than `node -e` one-liners: on win32 runCommand
// spawns through cmd.exe (for PATHEXT resolution), which mangles quoted args.
const scriptsDir = await mkdtemp(join(tmpdir(), "agentcore-exec-"));
async function script(name: string, source: string): Promise<string> {
  const path = join(scriptsDir, name);
  await writeFile(path, source);
  return path;
}

afterAll(() => rm(scriptsDir, { recursive: true, force: true }));

describe("toolOnPath", () => {
  test("finds a tool that exists", () => {
    // node is guaranteed present: it's running this test suite's runtime deps.
    expect(toolOnPath("node")).toBe(true);
  });

  test("misses a tool that does not exist", () => {
    expect(toolOnPath("definitely-not-a-real-tool-xyz")).toBe(false);
  });
});

describe("requireTool", () => {
  test("passes for an available tool", () => {
    expect(() => requireTool("node", "unused hint")).not.toThrow();
  });

  test("throws MissingToolError with the install hint", () => {
    expect(() =>
      requireTool("definitely-not-a-real-tool-xyz", "Install it from https://example.com"),
    ).toThrow(
      new MissingToolError("definitely-not-a-real-tool-xyz", "Install it from https://example.com"),
    );
  });
});

describe("runCommand", () => {
  test("resolves on exit 0 and streams output to onOutput", async () => {
    const succeeding = await script("succeed.js", "console.log('hello')");
    const chunks: string[] = [];
    await runCommand(["node", succeeding], {
      cwd: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("hello");
  });

  test("rejects with CommandFailedError carrying output and exit code", async () => {
    const failing = await script("fail.js", "console.error('boom'); process.exit(3)");
    const promise = runCommand(["node", failing], { cwd: process.cwd() });

    await expect(promise).rejects.toBeInstanceOf(CommandFailedError);
    await expect(promise).rejects.toThrow(/exit code 3/);
    await expect(promise).rejects.toThrow(/boom/);
  });

  test("rejects with CommandFailedError when the executable cannot spawn", async () => {
    await expect(
      runCommand(["definitely-not-a-real-tool-xyz"], { cwd: process.cwd() }),
    ).rejects.toBeInstanceOf(CommandFailedError);
  });
});
