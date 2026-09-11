import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogSource } from "../../../core/observability/index";
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
const HARNESS = { name: "support", path: "app/support" } as const;

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function inProject(harnesses: readonly unknown[], targets = [DEFAULT_TARGET]) {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-harness-log-"));
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
      throw new Error("project Harness logs resolve deployed resources");
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
        "harness",
        ...args,
        "--region",
        "us-east-1",
      ]),
  };
}

describe("project log harness", () => {
  test("resolves the Harness and its managed Runtime before tailing logs", async () => {
    await inProject([HARNESS]);
    const resolved = backend();
    const subject = command(resolved.value);
    subject.core.harness.setResolvedRuntime({
      runtimeId: "harness_support-XyZ123",
      runtimeName: "harness_support",
    });
    subject.core.observability.logEvents = [
      { timestamp: new Date("2026-09-10T12:00:00Z"), message: "ready" },
    ];

    await subject.run();

    expect(resolved.calls).toEqual([{ target: DEFAULT_TARGET }]);
    const harnessCall = subject.core.harness.calls[0]!;
    expect(harnessCall.method).toBe("resolveRuntime");
    expect(harnessCall.args[0]).toBe("support-AbCdEf1234");
    expect(harnessCall.args[1]).toEqual({
      region: DEFAULT_TARGET.region,
      endpointUrl: undefined,
    });

    const call = subject.core.observability.calls[0]!;
    expect(call.method).toBe("tailLogs");
    expect(call.args[0] as LogSource).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/harness_support-XyZ123-DEFAULT",
    });
    expect(call.args[2]).toEqual({ region: DEFAULT_TARGET.region, endpointUrl: undefined });
    expect(subject.io.stderr()).toContain(
      "Streaming logs for Harness 'support' on target 'default'... (Ctrl+C to stop)",
    );
    expect(subject.io.stdout()).toBe("2026-09-10T12:00:00.000Z  ready");
  });
});
