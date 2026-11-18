import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { localImageBuilds } from "./localImages";

const json = new FsReadWriteJson({ logger: createSilentLogger() });
// A real assembly synthesized by @aws/agentcore-cdk; see __fixtures__/local-images/README.md.
const FIXTURE = join(import.meta.dir, "__fixtures__", "local-images");
const ORDERS_HASH = "b418ebb81dba09fd5bd243309dc187c231c9f8ae8396e578aec20d56b26dc08e";
const ASSISTANT_HASH = "312890e9c6b30db7140a9db65b441447cec73a6a420ad53b95972974e99aa624";
const FIXTURE_BUILDS = {
  "runtime/orders": "ContainerLocal",
  "runtime/billing": "Container",
  "harness/assistant": "ContainerLocal",
} as const;

const directories: string[] = [];
afterEach(() => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

/** A writable copy of the fixture assembly. */
async function fixtureCopy(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-local-images-"));
  directories.push(directory);
  await cp(FIXTURE, directory, { recursive: true });
  return directory;
}

async function editJson(path: string, edit: (value: Record<string, any>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  edit(value);
  await writeFile(path, JSON.stringify(value));
}

describe("localImageBuilds", () => {
  test("finds the ContainerLocal images of a real synthesized assembly", async () => {
    // manifest.json references tree.json and a *.metadata.json the fixture omits.
    const images = await localImageBuilds(json, FIXTURE, "Fixture", FIXTURE_BUILDS);
    expect(images.map((image) => image.resource).sort()).toEqual([
      "harness/assistant",
      "runtime/orders",
    ]);
    const orders = images.find((image) => image.resource === "runtime/orders")!;
    expect(orders.directory).toBe(join(FIXTURE, `asset.${ORDERS_HASH}`));
    expect(orders.tag).toBe(`agentcore-local/fixture-runtime-orders:${ORDERS_HASH}`);
    expect(orders.command("docker")).toEqual([
      "docker",
      "build",
      "--platform",
      "linux/arm64",
      "--tag",
      orders.tag,
      "--file",
      "Dockerfile",
      ".",
    ]);
    const assistant = images.find((image) => image.resource === "harness/assistant")!;
    expect(assistant.directory).toBe(join(FIXTURE, `asset.${ASSISTANT_HASH}`));
    expect(assistant.command("finch")).toContain("linux/arm64");
  });

  test("ignores asset manifests and templates no current stack lists", async () => {
    const directory = await fixtureCopy();
    // Left by a synth before a target existed, when the stack had another name.
    await writeFile(
      join(directory, "AgentCore-Old.assets.json"),
      JSON.stringify({
        version: "36.0.0",
        files: {},
        dockerImages: { stale: { source: { directory: "asset.stale" } } },
      }),
    );
    await writeFile(
      join(directory, "AgentCore-Old.template.json"),
      JSON.stringify({ Metadata: { "agentcore:localImages": { "runtime/orders": "stale" } } }),
    );
    const images = await localImageBuilds(json, directory, "Fixture", FIXTURE_BUILDS);
    expect(images.map((image) => image.tag).sort()).toEqual([
      `agentcore-local/fixture-harness-assistant:${ASSISTANT_HASH}`,
      `agentcore-local/fixture-runtime-orders:${ORDERS_HASH}`,
    ]);
  });

  test("fails when a ContainerLocal workload has no recorded image", async () => {
    const directory = await fixtureCopy();
    await editJson(join(directory, "AgentCore-Fixture.template.json"), (template) => {
      delete template.Metadata["agentcore:localImages"]["harness/assistant"];
    });
    await expect(localImageBuilds(json, directory, "Fixture", FIXTURE_BUILDS)).rejects.toThrow(
      /no local image for harness\/assistant.*@aws\/agentcore-cdk package is too old/,
    );
  });

  test("fails when a recorded image is missing from the asset manifest", async () => {
    const directory = await fixtureCopy();
    await editJson(join(directory, "AgentCore-Fixture.assets.json"), (manifest) => {
      delete manifest.dockerImages[ORDERS_HASH];
    });
    await expect(localImageBuilds(json, directory, "Fixture", FIXTURE_BUILDS)).rejects.toThrow(
      /records image b418ebb8.* for runtime\/orders, but its asset manifest has no such image/,
    );
  });

  test("rejects malformed local image metadata", async () => {
    const directory = await fixtureCopy();
    await editJson(join(directory, "AgentCore-Fixture.template.json"), (template) => {
      template.Metadata["agentcore:localImages"] = { orders: ORDERS_HASH };
    });
    await expect(localImageBuilds(json, directory, "Fixture", FIXTURE_BUILDS)).rejects.toThrow(
      'invalid "agentcore:localImages" metadata',
    );
  });

  test("adds --load only on request, and returns nothing before synthesis", async () => {
    const [image] = await localImageBuilds(json, FIXTURE, "Fixture", {
      "runtime/orders": "ContainerLocal",
      "harness/assistant": "ContainerLocal",
    });
    expect(image!.command("docker", { load: true }).slice(0, 3)).toEqual([
      "docker",
      "build",
      "--load",
    ]);
    expect(image!.command("finch")).not.toContain("--load");
    expect(
      await localImageBuilds(json, join(tmpdir(), "agentcore-missing-assembly"), "Fixture", {
        "runtime/orders": "ContainerLocal",
      }),
    ).toEqual([]);
  });
});
