import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetTraceQuery, ListTracesQuery } from "../../../core/observability/index";
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
const HARNESSES = [
  { name: "support", path: "app/support" },
  { name: "sales", path: "app/sales" },
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
  harnesses: readonly unknown[],
  targets = [DEFAULT_TARGET, PRODUCTION_TARGET],
) {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-harness-traces-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  const spec = ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    harnesses,
  });
  await writeFile(join(root, "agentcore", "agentcore.json"), JSON.stringify(spec));
  await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  process.chdir(root);
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
      return project.spec.harnesses.map(({ name }) => ({
        resourceType: "harness" as const,
        name,
        id: `${name}-AbCdEf1234`,
        target: input.target,
      }));
    },
    async resolveProjectResources() {
      throw new Error("project Harness traces resolve deployed resources");
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
        "harness",
        ...args,
        "--region",
        "us-east-1",
      ]),
  };
}

describe("project traces harness", () => {
  test("selects a named Harness, target, and endpoint qualifier", async () => {
    await inProject(HARNESSES);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.harness.setResolvedRuntime({
      runtimeId: "harness_sales-XyZ456",
      runtimeName: "harness_sales",
    });

    await subject.run([
      "list",
      "--name",
      "sales",
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
    const harnessCall = subject.core.harness.calls[0]!;
    expect(harnessCall.args[0]).toBe("sales-AbCdEf1234");
    expect(harnessCall.args[1]).toEqual({
      region: PRODUCTION_TARGET.region,
      endpointUrl: undefined,
    });

    const call = subject.core.observability.calls[0]!;
    expect(call.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/harness_sales-XyZ456-BLUE",
    });
    expect(call.args[1] as ListTracesQuery).toMatchObject({ limit: 5 });
    expect(call.args[2]).toEqual({ region: PRODUCTION_TARGET.region, endpointUrl: undefined });
  });

  test("downloads a trace from the resolved Harness Runtime", async () => {
    await inProject([HARNESSES[0]]);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.harness.setResolvedRuntime({
      runtimeId: "harness_support-XyZ123",
      runtimeName: "harness_support",
    });
    subject.core.observability.traceRecords = [
      { "@timestamp": "2026-09-10 12:00:00.000", "@message": { body: "hello" } },
    ];

    await subject.run(["get", "abc123def456", "--output", "traces/trace.json"]);

    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("getTrace");
    expect(call.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/harness_support-XyZ123-DEFAULT",
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
