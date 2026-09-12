import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectBackend, ResolveDeployedResourcesBackendInput } from "../../../core/project";
import type { LogSource } from "../../../core/observability/index";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const cleanups: Array<() => Promise<void>> = [];
const DEFAULT_TARGET = {
  name: "default",
  account: "111122223333",
  region: "eu-west-1",
} as const;
const PRODUCTION_TARGET = {
  name: "production",
  account: "111122223333",
  region: "ap-southeast-2",
} as const;
const RUNTIMES = [
  {
    name: "checkout",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/checkout",
    runtimeVersion: "PYTHON_3_14",
  },
  {
    name: "inventory",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/inventory",
    runtimeVersion: "PYTHON_3_14",
  },
] as const;

afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function inProject(
  runtimes: readonly unknown[],
  targets = [DEFAULT_TARGET, PRODUCTION_TARGET],
) {
  const { projectRoot, cleanup } = await initProject({
    name: "orders",
    flags: ["--template", "empty"],
    prefix: "agentcore-project-log-",
  });
  cleanups.push(cleanup);
  const spec = ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    runtimes,
  });
  await writeFile(join(projectRoot, "agentcore", "agentcore.json"), JSON.stringify(spec));
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), JSON.stringify(targets));
}

function backend(options: { deployed?: boolean } = {}) {
  const calls: ResolveDeployedResourcesBackendInput[] = [];
  const value: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield* [];
      return { outputs: {} };
    },
    async resolveDeployedResources(project, input) {
      calls.push(input);
      if (options.deployed === false) return [];
      return project.spec.runtimes.map(({ name }) => ({
        resourceType: "runtime" as const,
        name,
        id: `${name}-AbCdEf1234`,
        target: input.target,
      }));
    },
    async resolveProjectResources() {
      throw new Error("project log resolves deployed resources, not project resources");
    },
  };
  return { calls, value };
}

function command(projectBackend: ProjectBackend) {
  const core = new TestCoreClient({ backends: { CDK: projectBackend } });
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    run: (args: string[] = []) =>
      root.route([
        "bun",
        "agentcore",
        "project",
        "log",
        "runtime",
        ...args,
        "--region",
        "us-east-1",
      ]),
  };
}

describe("project log runtime", () => {
  test("resolves the only logical Runtime and tails it in the target region", async () => {
    await inProject([RUNTIMES[0]]);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.observability.logEvents = [
      { timestamp: new Date("2026-09-10T12:00:00Z"), message: "ready" },
    ];

    await subject.run();

    expect(resolved.calls).toEqual([{ target: DEFAULT_TARGET }]);
    expect(subject.core.observability.calls).toHaveLength(1);
    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("tailLogs");
    expect(call.args[0] as LogSource).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/checkout-AbCdEf1234-DEFAULT",
    });
    expect(call.args[1]).toEqual({ filterPattern: undefined });
    expect(call.args[2]).toEqual({ region: DEFAULT_TARGET.region, endpointUrl: undefined });
    expect(subject.io.stderr()).toContain(
      "Streaming logs for Runtime 'checkout' on target 'default'... (Ctrl+C to stop)",
    );
    expect(subject.io.stdout()).toBe("2026-09-10T12:00:00.000Z  ready");
  });

  test("selects a named Runtime and deployment target for a bounded search", async () => {
    await inProject(RUNTIMES);
    const resolved = backend();
    const subject = command(resolved.value);

    await subject.run([
      "--name",
      "inventory",
      "--target",
      "production",
      "--qualifier",
      "BLUE",
      "--since",
      "1h",
      "--limit",
      "25",
    ]);

    expect(resolved.calls).toEqual([{ target: PRODUCTION_TARGET }]);
    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("searchLogs");
    expect(call.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/inventory-AbCdEf1234-BLUE",
    });
    expect(call.args[1]).toMatchObject({ limit: 25 });
    expect(call.args[2]).toEqual({ region: PRODUCTION_TARGET.region, endpointUrl: undefined });
  });

  test("requires --name when the project declares several Runtimes", async () => {
    await inProject(RUNTIMES);
    const resolved = backend();
    const subject = command(resolved.value);

    await expect(subject.run(["--since", "1h"])).rejects.toThrow(
      "Project has multiple Runtimes. Specify --name: checkout, inventory.",
    );

    expect(resolved.calls).toEqual([]);
    expect(subject.core.observability.calls).toEqual([]);
  });

  test("reports when the selected logical Runtime is not deployed", async () => {
    await inProject([RUNTIMES[0]]);
    const resolved = backend({ deployed: false });
    const subject = command(resolved.value);

    await expect(subject.run(["--since", "1h"])).rejects.toThrow(
      "Runtime 'checkout' is not deployed to target 'default'.",
    );

    expect(subject.core.observability.calls).toEqual([]);
  });
});
