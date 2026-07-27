import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { SourceResolutionError, SourceResolver } from "./source";

const tempDirectories: string[] = [];

async function tempFile(contents: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-source-"));
  tempDirectories.push(directory);
  const path = join(directory, "source");
  await writeFile(path, contents);
  return path;
}

function stdin(...chunks: Uint8Array[]): NodeJS.ReadStream {
  return Readable.from(chunks) as NodeJS.ReadStream;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SourceResolver bytes", () => {
  test("passes undefined through", async () => {
    const resolver = new SourceResolver({ stdin: stdin() });

    expect(await resolver.resolveBytes("payload", undefined)).toBeUndefined();
  });

  test("encodes inline values as UTF-8", async () => {
    const resolver = new SourceResolver({ stdin: stdin() });

    expect(await resolver.resolveBytes("payload", "hello \u20ac")).toEqual(
      new TextEncoder().encode("hello \u20ac"),
    );
  });

  test("preserves arbitrary file bytes", async () => {
    const bytes = Uint8Array.from([0, 255, 10, 1]);
    const path = await tempFile(bytes);
    const resolver = new SourceResolver({ stdin: stdin() });

    expect(await resolver.resolveBytes("payload", `file://${path}`)).toEqual(bytes);
  });

  test("preserves arbitrary stdin bytes", async () => {
    const bytes = Uint8Array.from([9, 0, 254]);
    const resolver = new SourceResolver({ stdin: stdin(bytes) });

    expect(await resolver.resolveBytes("payload", "-")).toEqual(bytes);
  });

  test("rejects a second stdin consumer and identifies both options", async () => {
    const resolver = new SourceResolver({ stdin: stdin(new TextEncoder().encode("value")) });

    await resolver.resolveText("payload", "-");
    const resolution = resolver.resolveText("bearer-token", "-");

    await expect(resolution).rejects.toBeInstanceOf(SourceResolutionError);
    await expect(resolution).rejects.toThrow("'--bearer-token' conflicts with '--payload'");
  });

  test("claims stdin before concurrent resolutions can race", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const resolver = new SourceResolver({ stdin: input });
    const first = resolver.resolveBytes("first", "-");
    const second = resolver.resolveBytes("second", "-");

    await expect(second).rejects.toThrow("'--second' conflicts with '--first'");
    input.end("value");
    expect(new TextDecoder().decode(await first)).toBe("value");
  });

  test("reports file failures with option and path context", async () => {
    const missing = join(tmpdir(), "agentcore-source-missing", "secret-value");
    const resolver = new SourceResolver({ stdin: stdin() });

    const resolution = resolver.resolveBytes("payload", `file://${missing}`);
    await expect(resolution).rejects.toBeInstanceOf(SourceResolutionError);
    await expect(resolution).rejects.toThrow(`could not read '--payload' from file '${missing}'`);
  });

  test("wraps non-abort stdin failures with option context", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const resolver = new SourceResolver({ stdin: input });
    const resolution = resolver.resolveBytes("payload", "-");
    input.destroy(new Error("stream failed"));

    await expect(resolution).rejects.toBeInstanceOf(SourceResolutionError);
    await expect(resolution).rejects.toThrow("could not read '--payload' from stdin");
  });
});

describe("SourceResolver text", () => {
  test("passes undefined through", async () => {
    const resolver = new SourceResolver({ stdin: stdin() });

    expect(await resolver.resolveText("value", undefined)).toBeUndefined();
  });

  test("resolves inline, file, and stdin text without transforming it", async () => {
    const path = await tempFile("file\nvalue");

    expect(
      await new SourceResolver({ stdin: stdin() }).resolveText("inline", " inline value "),
    ).toBe(" inline value ");
    expect(await new SourceResolver({ stdin: stdin() }).resolveText("file", `file://${path}`)).toBe(
      "file\nvalue",
    );
    expect(
      await new SourceResolver({
        stdin: stdin(new TextEncoder().encode("stdin\nvalue")),
      }).resolveText("stdin", "-"),
    ).toBe("stdin\nvalue");
  });

  test("rejects malformed UTF-8 with option context", async () => {
    const path = await tempFile(Uint8Array.from([0xff, 0x61]));
    const resolver = new SourceResolver({ stdin: stdin() });
    const resolution = resolver.resolveText("api-key", `file://${path}`);

    await expect(resolution).rejects.toBeInstanceOf(SourceResolutionError);
    await expect(resolution).rejects.toThrow("'--api-key' must contain valid UTF-8");
  });
});

describe("SourceResolver cancellation", () => {
  test("rejects an already-aborted inline resolution", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolver = new SourceResolver({
      stdin: stdin(),
      signal: controller.signal,
    });
    const resolution = resolver.resolveBytes("payload", "inline");

    await expect(resolution).rejects.toMatchObject({ name: "AbortError" });
    await expect(resolution).rejects.not.toBeInstanceOf(SourceResolutionError);
  });

  test("preserves AbortError from file resolution", async () => {
    const path = await tempFile("payload");
    const controller = new AbortController();
    controller.abort();
    const resolver = new SourceResolver({
      stdin: stdin(),
      signal: controller.signal,
    });
    const resolution = resolver.resolveBytes("payload", `file://${path}`);

    await expect(resolution).rejects.toMatchObject({ name: "AbortError" });
    await expect(resolution).rejects.not.toBeInstanceOf(SourceResolutionError);
  });

  test("aborts while waiting for stdin and preserves AbortError", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const controller = new AbortController();
    const resolver = new SourceResolver({
      stdin: input,
      signal: controller.signal,
    });
    const resolution = resolver.resolveBytes("payload", "-");

    controller.abort();

    try {
      await expect(
        Promise.race([
          resolution,
          Bun.sleep(100).then(() => {
            throw new Error("stdin read did not abort");
          }),
        ]),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(resolution).rejects.not.toBeInstanceOf(SourceResolutionError);
    } finally {
      input.destroy();
      await resolution.catch(() => {});
    }
  });
});
