import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetTraceQuery, ListTracesQuery, LogSource } from "../../../core/observability/index";
import type { ProjectBackend, ResolveDeployedResourcesBackendInput } from "../../../core/project";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];
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

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function inProject(
  runtimes: readonly unknown[],
  targets = [DEFAULT_TARGET, PRODUCTION_TARGET],
) {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-traces-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  const spec = ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    runtimes,
  });
  await writeFile(join(root, "agentcore", "agentcore.json"), JSON.stringify(spec));
  await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  process.chdir(root);
  return root;
}

function backend() {
  const calls: ResolveDeployedResourcesBackendInput[] = [];
  const value: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield* [];
      return { outputs: {} };
    },
    async resolveDeployedResources(project, input) {
      calls.push(input);
      return project.spec.runtimes.map(({ name }) => ({
        resourceType: "runtime" as const,
        name,
        id: `${name}-AbCdEf1234`,
        target: input.target,
      }));
    },
    async resolveProjectResources() {
      throw new Error("project traces resolve deployed resources, not project resources");
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
    run: (args: string[]) =>
      root.route([
        "bun",
        "agentcore",
        "project",
        "traces",
        "runtime",
        ...args,
        "--region",
        "us-east-1",
      ]),
  };
}

describe("project traces runtime", () => {
  test("resolves the only logical Runtime and lists traces in the target region", async () => {
    await inProject([RUNTIMES[0]]);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.observability.traceSummaries = [
      {
        traceId: "abc123",
        timestamp: "1709391000000",
        sessionId: "session-1",
      },
    ];

    await subject.run(["list", "--since", "1h"]);

    expect(resolved.calls).toEqual([{ target: DEFAULT_TARGET }]);
    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("listTraces");
    expect(call.args[0] as LogSource).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/checkout-AbCdEf1234-DEFAULT",
    });
    expect(call.args[1] as ListTracesQuery).toMatchObject({ limit: 20 });
    expect(call.args[2]).toEqual({ region: DEFAULT_TARGET.region, endpointUrl: undefined });
    expect(subject.io.stdout()).toContain("abc123");
  });

  test("selects a named Runtime, deployment target, and endpoint qualifier", async () => {
    await inProject(RUNTIMES);
    const resolved = backend();
    const subject = command(resolved.value);

    await subject.run([
      "list",
      "--name",
      "inventory",
      "--target",
      "production",
      "--qualifier",
      "BLUE",
      "--since",
      "1h",
      "--limit",
      "5",
    ]);

    expect(resolved.calls).toEqual([{ target: PRODUCTION_TARGET }]);
    const call = subject.core.observability.calls[0]!;
    expect(call.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/inventory-AbCdEf1234-BLUE",
    });
    expect(call.args[1] as ListTracesQuery).toMatchObject({ limit: 5 });
    expect(call.args[2]).toEqual({ region: PRODUCTION_TARGET.region, endpointUrl: undefined });
  });

  test("downloads a trace from the resolved Runtime", async () => {
    await inProject([RUNTIMES[0]]);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.observability.traceRecords = [
      { "@timestamp": "2026-09-10 12:00:00.000", "@message": { body: "hello" } },
    ];

    await subject.run(["get", "abc123def456", "--output", "traces/trace.json"]);

    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("getTrace");
    expect(call.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/checkout-AbCdEf1234-DEFAULT",
    });
    expect(call.args[1] as GetTraceQuery).toMatchObject({ traceId: "abc123def456" });
    expect(call.args[2]).toEqual({ region: DEFAULT_TARGET.region, endpointUrl: undefined });

    const output = join(process.cwd(), "traces", "trace.json");
    expect(subject.io.stdout()).toBe(output);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(
      subject.core.observability.traceRecords,
    );
  });
});
