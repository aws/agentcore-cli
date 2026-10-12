import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeserializationError, InputValidationError, ProjectStateError } from "../errors";
import { createRootHandler } from "../handlers";
import {
  createSilentLogger,
  inTempDirectory,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../testing";
import { V0_PROJECT_ADD_REMOVE_MESSAGE } from "./withV0ProjectGuard";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function projectWithSpec(spec: string): Promise<{ root: string; specPath: string }> {
  const { path, cleanup } = await inTempDirectory("agentcore-v0-guard-");
  cleanups.push(cleanup);
  const specPath = join(path, "agentcore", "agentcore.json");
  await mkdir(join(path, "agentcore"));
  await writeFile(specPath, spec);
  return { root: path, specPath };
}

function run(args: string[]): Promise<void> {
  const root = createRootHandler(new TestCoreClient(), {
    io: testIO().io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return root.route(["node", "agentcore", ...args]);
}

describe("v0 project add/remove guard", () => {
  test.each([
    { label: "add runtime", args: ["add", "runtime", "--name", "agent"] },
    { label: "bare add", args: ["add"] },
    { label: "remove runtime", args: ["remove", "runtime", "--name", "agent"] },
    { label: "remove all", args: ["remove", "all", "--yes"] },
  ])("blocks $label before changing a v0 project", async ({ args }) => {
    const { root, specPath } = await projectWithSpec('{"name":"Legacy","version":1}\n');
    await mkdir(join(root, "app", "nested"), { recursive: true });
    process.chdir(join(root, "app", "nested"));
    const before = await readFile(specPath, "utf8");

    await expect(run([...args])).rejects.toThrow(
      new ProjectStateError(V0_PROJECT_ADD_REMOVE_MESSAGE),
    );
    expect(await readFile(specPath, "utf8")).toBe(before);
  });

  test("uses the add/remove error even when the old CDK dependency warning applies", async () => {
    const { root } = await projectWithSpec('{"name":"Legacy","version":1}\n');
    const cdkPath = join(root, "agentcore", "cdk");
    await mkdir(cdkPath);
    await writeFile(
      join(cdkPath, "package.json"),
      '{"dependencies":{"@aws/agentcore-cdk":"^0.1.0-alpha.19"}}',
    );

    await expect(run(["remove", "runtime", "--name", "agent"])).rejects.toThrow(
      new ProjectStateError(V0_PROJECT_ADD_REMOVE_MESSAGE),
    );
  });

  test("allows v1 projects through to normal command validation", async () => {
    await projectWithSpec('{"name":"Current","version":2}\n');

    await expect(run(["remove"])).rejects.toBeInstanceOf(InputValidationError);
  });

  test("preserves normal validation for a malformed project file", async () => {
    await projectWithSpec("{ not valid json");

    await expect(run(["remove", "runtime", "--name", "agent"])).rejects.toBeInstanceOf(
      DeserializationError,
    );
  });
});
