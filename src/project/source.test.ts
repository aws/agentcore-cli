import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { embeddedSource, fileSource } from "./source";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-source-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("fileSource", () => {
  test("reads an asset relative to the assets root", async () => {
    const root = await makeTempDirectory();
    await mkdir(join(root, "cdk"), { recursive: true });
    await Bun.write(join(root, "cdk", "package.json"), "{}");

    expect(await fileSource(root).read("cdk/package.json")()).toBe("{}");
  });

  test("lists files under a directory as sorted, forward-slash asset paths", async () => {
    const root = await makeTempDirectory();
    await mkdir(join(root, "cdk", "bin"), { recursive: true });
    await Bun.write(join(root, "cdk", "package.json"), "{}");
    await Bun.write(join(root, "cdk", "bin", "cdk.ts"), "");

    expect(await fileSource(root).list("cdk")).toEqual(["cdk/bin/cdk.ts", "cdk/package.json"]);
  });
});

describe("embeddedSource", () => {
  // Bun.embeddedFiles is empty outside a compiled executable, so any lookup
  // misses — this exercises the miss path deterministically in `bun test`.
  test("throws when the asset is not embedded", () => {
    expect(() => embeddedSource.read("cdk/package.json")()).toThrow(/Embedded asset not found/);
  });
});
