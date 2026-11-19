import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  expectError,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { InputValidationError } from "../../../../errors";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function run(args: string[]) {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", ...args]);
  return io;
}

async function projectSpec(projectRoot: string) {
  return JSON.parse(await readFile(join(projectRoot, "agentcore", "agentcore.json"), "utf8"));
}

describe("project add knowledge-base", () => {
  test("adds S3 data sources to the project spec", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);

    const io = await run([
      "add",
      "knowledge-base",
      "--name",
      "docs",
      "--description",
      "Product documentation",
      "--data-source",
      "s3://my-bucket/docs",
      "--data-source",
      "s3://my-other-bucket/docs",
    ]);

    expect((await projectSpec(projectRoot)).knowledgeBases).toEqual([
      {
        type: "AgentCoreKnowledgeBase",
        name: "docs",
        description: "Product documentation",
        dataSources: [
          { type: "S3", uri: "s3://my-bucket/docs" },
          { type: "S3", uri: "s3://my-other-bucket/docs" },
        ],
      },
    ]);
    expect(io.stderr()).toContain("added Knowledge Base 'docs' to 'TestProject'");
  });

  test("rejects an invalid S3 URI", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);

    await expectError(
      run(["add", "knowledge-base", "--name", "docs", "--data-source", "s3://BadBucket/docs"]),
      "Must be a valid s3:// URI",
      InputValidationError,
    );
  });

  test("removes a knowledge base", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "knowledge-base", "--name", "docs", "--data-source", "s3://my-bucket/docs"]);

    await run(["remove", "knowledge-base", "--name", "docs"]);

    expect((await projectSpec(projectRoot)).knowledgeBases).toEqual([]);
  });
});
