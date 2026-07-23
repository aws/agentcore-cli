import { test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppIO } from "../types";
import { SourceResolver } from "./source";

function ioWithStdin(input: string): AppIO {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.push(input);
  stdin.push(null);
  return {
    stdin,
    stdout: new PassThrough() as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
  };
}

test("resolve returns inline values and passes undefined through", async () => {
  const r = new SourceResolver(ioWithStdin(""));
  expect(await r.resolve("f", "hello")).toBe("hello");
  expect(await r.resolve("f", undefined)).toBeUndefined();
});

test("resolve reads file:// paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "source-test-"));
  const file = join(dir, "v.txt");
  writeFileSync(file, "from file");
  try {
    const r = new SourceResolver(ioWithStdin(""));
    expect(await r.resolve("f", `file://${file}`)).toBe("from file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve reads stdin for `-`", async () => {
  const r = new SourceResolver(ioWithStdin("from stdin"));
  expect(await r.resolve("f", "-")).toBe("from stdin");
});

test("resolve rejects a second stdin source", async () => {
  const r = new SourceResolver(ioWithStdin("only once"));
  await r.resolve("a", "-");
  await expect(r.resolve("b", "-")).rejects.toThrow(/only one option may read from stdin/);
});

test("resolve reports a helpful error for a missing file", async () => {
  const r = new SourceResolver(ioWithStdin(""));
  await expect(r.resolve("f", "file:///nope/missing.txt")).rejects.toThrow(/could not read/);
});
