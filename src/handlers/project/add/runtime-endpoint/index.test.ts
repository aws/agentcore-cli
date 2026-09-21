import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
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
import { InputValidationError, ResourceNotFoundError } from "../../../../errors";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function run(args: string[], opts?: { isTTY?: boolean }) {
  const io = testIO({ isTTY: opts?.isTTY });
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io };
}

function specPath(projectRoot: string): string {
  return join(projectRoot, "agentcore", "agentcore.json");
}

async function readSpec(projectRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(specPath(projectRoot), "utf-8"));
}

// A minimal runtime is enough for an endpoint's parent; scaffolding a real one
// would install dependencies the endpoint path never touches.
async function seedRuntime(projectRoot: string, name = "agent") {
  const spec = await readSpec(projectRoot);
  spec.runtimes = [
    {
      name,
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: `app/${name}`,
      runtimeVersion: "PYTHON_3_13",
    },
  ];
  await writeFile(specPath(projectRoot), JSON.stringify(spec, null, 2));
}

async function endpointsOf(projectRoot: string, runtime = "agent") {
  const spec = await readSpec(projectRoot);
  const runtimes = spec.runtimes as Array<{ name: string; endpoints?: unknown }>;
  return runtimes.find((r) => r.name === runtime)?.endpoints;
}

describe("project add runtime-endpoint", () => {
  test("writes the endpoint into the runtime's endpoints record", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);

    await run([
      "add",
      "runtime-endpoint",
      "--runtime",
      "agent",
      "--name",
      "prod",
      "--version",
      "3",
      "--description",
      "Production endpoint",
    ]);

    expect(await endpointsOf(projectRoot)).toEqual({
      prod: { version: 3, description: "Production endpoint" },
    });
  });

  test("defaults version to 1", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);

    await run(["add", "runtime-endpoint", "--runtime", "agent", "--name", "staging"]);

    expect(await endpointsOf(projectRoot)).toEqual({ staging: { version: 1 } });
  });

  test("--json returns a structured mutation result naming the parent runtime", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);

    const { io } = await run([
      "add",
      "runtime-endpoint",
      "--runtime",
      "agent",
      "--name",
      "prod",
      "--json",
    ]);

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "add",
      project: { name: "TestProject", path: projectRoot },
      resource: {
        type: "runtime-endpoint",
        name: "prod",
        parent: { type: "runtime", name: "agent" },
      },
    });
  });

  test.each<
    [label: string, extra: string[], message: string, errorType?: Parameters<typeof expectError>[2]]
  >([
    ["missing runtime", ["--name", "prod"], "required option '--runtime"],
    ["missing name", ["--runtime", "agent"], "required option '--name"],
    [
      "unknown runtime",
      ["--runtime", "ghost", "--name", "prod"],
      "no runtime named 'ghost'",
      ResourceNotFoundError,
    ],
  ])("rejects %s", async (_label, extra, message, errorType = InputValidationError) => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);

    await expectError(run(["add", "runtime-endpoint", ...extra]), message, errorType);
  });

  test("rejects a duplicate endpoint name on the same runtime", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);
    await run(["add", "runtime-endpoint", "--runtime", "agent", "--name", "prod"]);

    await expect(
      run(["add", "runtime-endpoint", "--runtime", "agent", "--name", "prod"]),
    ).rejects.toThrow("already exists");
  });

  test("remove deletes the endpoint and prunes an emptied record", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await seedRuntime(projectRoot);
    await run(["add", "runtime-endpoint", "--runtime", "agent", "--name", "prod"]);

    await run(["remove", "runtime-endpoint", "--runtime", "agent", "--name", "prod"]);

    expect(await endpointsOf(projectRoot)).toBeUndefined();
  });
});
