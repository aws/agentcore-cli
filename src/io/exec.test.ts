import { describe, expect, test } from "bun:test";
import { CommandFailedError, MissingToolError, requireTool, runCommand, toolOnPath } from "./exec";

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
    const chunks: string[] = [];
    await runCommand(["node", "-e", "console.log('hello')"], {
      cwd: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("hello");
  });

  test("rejects with CommandFailedError carrying output and exit code", async () => {
    const command = ["node", "-e", "console.error('boom'); process.exit(3)"];
    const promise = runCommand(command, { cwd: process.cwd() });

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
