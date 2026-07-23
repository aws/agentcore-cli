import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { readSource, readSourceText } from "./source";

const TMP = join(tmpdir(), "source-test-" + Date.now());

function fakeStdin(content: string): NodeJS.ReadStream {
  const stream = Readable.from([Buffer.from(content)]);
  return stream as unknown as NodeJS.ReadStream;
}

describe("readSource", () => {
  test("returns inline value as UTF-8 bytes", async () => {
    const result = await readSource("hello");
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  test("reads from a file:// path", async () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "key.txt");
    writeFileSync(path, "file-content");
    try {
      const result = await readSource(`file://${path}`);
      expect(new TextDecoder().decode(result)).toBe("file-content");
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  test("throws on unreadable file:// path", async () => {
    await expect(readSource("file:///nonexistent/path.txt")).rejects.toThrow(
      "unable to read source file",
    );
  });

  test("reads from stdin when source is -", async () => {
    const stdin = fakeStdin("stdin-content");
    const result = await readSource("-", stdin);
    expect(new TextDecoder().decode(result)).toBe("stdin-content");
  });

  test("throws when stdin is - but no stdin available", async () => {
    await expect(readSource("-")).rejects.toThrow("stdin is not available");
  });
});

describe("readSourceText", () => {
  test("returns inline value as string", async () => {
    expect(await readSourceText("my-key")).toBe("my-key");
  });

  test("reads file and returns string", async () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "secret.txt");
    writeFileSync(path, "secret-from-file");
    try {
      expect(await readSourceText(`file://${path}`)).toBe("secret-from-file");
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  test("reads stdin and returns string", async () => {
    const stdin = fakeStdin("piped-secret");
    expect(await readSourceText("-", stdin)).toBe("piped-secret");
  });
});
