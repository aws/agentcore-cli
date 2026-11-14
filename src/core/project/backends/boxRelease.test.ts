import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { resolveBoxLinuxBuild } from "./boxRelease";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const BINARIES = ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"];

async function boxSource(options: { ffi?: boolean } = {}): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "box-source-"));
  directories.push(source);
  await mkdir(join(source, "target-al2023", "release"), { recursive: true });
  for (const binary of BINARIES) {
    await writeFile(join(source, "target-al2023", "release", binary), `#!${binary}\n`);
  }
  await mkdir(join(source, "resources"), { recursive: true });
  if (options.ffi) await mkdir(join(source, "target-al2023", "ffi"), { recursive: true });
  return source;
}

describe("resolveBoxLinuxBuild", () => {
  test("uses the Amazon Linux 2023 build and packs in AGENTCORE_BOX_SOURCE", async () => {
    const source = await boxSource({ ffi: true });

    const build = await resolveBoxLinuxBuild({ AGENTCORE_BOX_SOURCE: source });

    expect(build).toEqual({
      binaries: join(source, "target-al2023", "release"),
      resources: join(source, "resources"),
      ffi: { PYTHON_3_14: join(source, "target-al2023", "ffi") },
    });
  });

  test("ships no ffi shim when the checkout has none", async () => {
    const build = await resolveBoxLinuxBuild({ AGENTCORE_BOX_SOURCE: await boxSource() });

    expect(build.ffi).toEqual({});
  });

  test("says to set AGENTCORE_BOX_SOURCE when it is unset", async () => {
    const result = resolveBoxLinuxBuild({});

    await expect(result).rejects.toThrow(InvalidEnvironmentError);
    await expect(result).rejects.toThrow(/Set AGENTCORE_BOX_SOURCE/);
  });

  test("names the binary the local build lacks", async () => {
    const source = await boxSource();
    await rm(join(source, "target-al2023", "release", "strands-box-sock-alias"));

    await expect(resolveBoxLinuxBuild({ AGENTCORE_BOX_SOURCE: source })).rejects.toThrow(
      /has no .*target-al2023\/release\/strands-box-sock-alias/,
    );
  });
});
