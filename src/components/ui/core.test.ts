import { describe, expect, test } from "bun:test";
import { unicodeSupported } from "./_core";

describe("unicodeSupported", () => {
  test.each([
    [{}, "darwin", true],
    [{ TERM: "linux" }, "linux", false],
    [{}, "win32", false],
    [{ WT_SESSION: "1" }, "win32", true],
    [{ TERM_PROGRAM: "vscode" }, "win32", true],
    [{ ConEmuTask: "{cmd::Cmder}" }, "win32", true],
    [{ TERMINUS_SUBLIME: "1" }, "win32", true],
    [{ CI: "true" }, "win32", true],
  ] as const)("env %o on %s -> %s", (env, platform, expected) => {
    expect(unicodeSupported(env, platform)).toBe(expected);
  });
});
