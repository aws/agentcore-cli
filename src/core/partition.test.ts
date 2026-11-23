import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isChinaContext, isChinaRegion, supportsRuntimeV2 } from "./partition";

describe("isChinaRegion", () => {
  test.each(["cn-north-1", "cn-northwest-1"])("returns true for %s", (region) => {
    expect(isChinaRegion(region)).toBe(true);
  });

  test.each(["us-east-1", "eu-west-1", "us-gov-west-1", ""])("returns false for %j", (region) => {
    expect(isChinaRegion(region)).toBe(false);
  });
});

describe("supportsRuntimeV2", () => {
  // ap-east-9 is not a region: one this CLI does not know of counts as having V2, as the European
  // Sovereign Cloud (eusc-de-east-1) does.
  test.each(["us-west-2", "us-east-1", "eu-west-1", "cn-north-1", "ap-east-9", "eusc-de-east-1"])(
    "returns true for %s",
    (region) => {
      expect(supportsRuntimeV2(region)).toBe(true);
    },
  );

  test.each([
    "ap-south-2",
    "us-west-1",
    "us-gov-west-1",
    "us-gov-east-1",
    "us-iso-east-1",
    "us-isob-east-1",
    "us-isof-south-1",
    "eu-isoe-west-1",
  ])("returns false for %s", (region) => {
    expect(supportsRuntimeV2(region)).toBe(false);
  });
});

describe("isChinaContext", () => {
  let savedRegion: string | undefined;
  let savedDefaultRegion: string | undefined;
  let directory: string;

  beforeEach(async () => {
    savedRegion = process.env.AWS_REGION;
    savedDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    directory = await mkdtemp(join(tmpdir(), "agentcore-partition-"));
  });

  afterEach(async () => {
    if (savedRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = savedRegion;
    if (savedDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = savedDefaultRegion;
    await rm(directory, { recursive: true, force: true });
  });

  async function projectWithTargets(targets: unknown): Promise<string> {
    const root = join(directory, "project");
    await mkdir(join(root, "agentcore"), { recursive: true });
    await writeFile(join(root, "agentcore", "agentcore.json"), "{}");
    if (targets !== undefined) {
      await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify(targets));
    }
    return root;
  }

  test("true when the ambient region env var is a China region", async () => {
    process.env.AWS_REGION = "cn-northwest-1";
    expect(await isChinaContext({ cwd: directory })).toBe(true);
  });

  test("true when the caller passes a resolved China region", async () => {
    expect(await isChinaContext({ region: "cn-north-1", cwd: directory })).toBe(true);
    expect(await isChinaContext({ region: "us-west-2", cwd: directory })).toBe(false);
  });

  test("true when the enclosing project declares a China deployment target", async () => {
    const root = await projectWithTargets([
      { name: "primary", account: "111122223333", region: "us-west-2" },
      { name: "china", account: "111122223333", region: "cn-north-1" },
    ]);
    expect(await isChinaContext({ cwd: root })).toBe(true);
    // The walk finds the project from a nested path as well.
    expect(await isChinaContext({ cwd: join(root, "app", "nested") })).toBe(true);
  });

  test("false for a project with only commercial targets", async () => {
    const root = await projectWithTargets([
      { name: "primary", account: "111122223333", region: "us-west-2" },
    ]);
    expect(await isChinaContext({ cwd: root })).toBe(false);
  });

  test("false when no project encloses the directory", async () => {
    expect(await isChinaContext({ cwd: directory })).toBe(false);
  });

  test("false when the targets file is missing or malformed", async () => {
    const noTargets = await projectWithTargets(undefined);
    expect(await isChinaContext({ cwd: noTargets })).toBe(false);

    await writeFile(join(noTargets, "agentcore", "aws-targets.json"), "not json");
    expect(await isChinaContext({ cwd: noTargets })).toBe(false);
  });
});
