import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { stackArtifactIdForTarget } from "./assembly";

const temporaryDirectories: string[] = [];
const json = new FsReadWriteJson({ logger: createSilentLogger() });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function assembly(artifacts: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-assembly-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ artifacts }));
  return directory;
}

describe("stackArtifactIdForTarget", () => {
  test("selects by the target tag instead of deriving a stack name", async () => {
    const directory = await assembly({
      "nested/stack-id": {
        type: "aws:cloudformation:stack",
        properties: {
          tags: { "agentcore:target-name": "prod" },
        },
      },
    });

    expect(await stackArtifactIdForTarget(json, directory, "prod")).toBe("nested/stack-id");
  });

  test("ignores non-stack artifacts", async () => {
    const directory = await assembly({
      Tree: {
        type: "cdk:tree",
        properties: {
          tags: { "agentcore:target-name": "prod" },
        },
      },
    });

    await expect(stackArtifactIdForTarget(json, directory, "prod")).rejects.toThrow(
      /defines 0 stack/,
    );
  });

  test("reports a missing manifest before attempting deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-assembly-"));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });

    await expect(stackArtifactIdForTarget(json, directory, "prod")).rejects.toThrow(
      /No synthesized cloud assembly was found/,
    );
  });
});
