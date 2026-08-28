import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { atomicWrite, atomicWriteStream } from "./atomicWrite";

const dirs: string[] = [];
const testPosix = process.platform === "win32" ? test.skip : test;
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atomic-write-"));
  dirs.push(d);
  return d;
}

test("writes contents and leaves no temp file", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");

  await atomicWrite(target, "hello");

  expect(await Bun.file(target).text()).toBe("hello");
  expect(await readdir(dir)).toEqual(["out.txt"]);
});

test("overwrites an existing file", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");
  await writeFile(target, "old");

  await atomicWrite(target, "new");

  expect(await Bun.file(target).text()).toBe("new");
  expect(await readdir(dir)).toEqual(["out.txt"]);
});

testPosix("creates the replacement file with the requested mode", async () => {
  const dir = await tempDir();
  const target = join(dir, "secret.txt");

  await atomicWrite(target, "secret", { mode: 0o600 });

  expect((await stat(target)).mode & 0o777).toBe(0o600);
});

test("cleans up the temp file when rename fails", async () => {
  const dir = await tempDir();
  // Target path is a directory → rename onto it fails, exercising the catch.
  const target = join(dir, "adir");
  await Bun.write(join(target, "keep"), "x");

  await expect(atomicWrite(target, "data")).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["adir"]);
});

test("streams contents through transforms and leaves no temp file", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");
  const source = Readable.toWeb(
    Readable.from([new TextEncoder().encode("hello")]),
  ) as ReadableStream<Uint8Array>;
  const appendNewline = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      callback(null, "\n");
    },
  });

  await atomicWriteStream(target, source, { transforms: [appendNewline] });

  expect(await Bun.file(target).text()).toBe("hello\n");
  expect(await readdir(dir)).toEqual(["out.txt"]);
});

test("keeps the existing file and cleans up the temp file when streaming fails", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");
  await writeFile(target, "old");
  const source = new Readable({
    read() {
      this.push("partial");
      this.destroy(new Error("stream failed"));
    },
  });

  await expect(atomicWriteStream(target, source)).rejects.toThrow("stream failed");

  expect(await Bun.file(target).text()).toBe("old");
  expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});
