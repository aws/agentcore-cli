import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile } from "./fileRead";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "read-text-file-"));
  dirs.push(dir);
  const path = join(dir, "in.txt");
  writeFileSync(path, contents);
  return path;
}

describe("readTextFile", () => {
  test("reads UTF-8 text from a file", async () => {
    const path = tempFile("hello\n");

    await expect(readTextFile(path)).resolves.toBe("hello\n");
  });

  test("throws before reading when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("aborted"));

    await expect(readTextFile(tempFile("hello"), { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });
});
