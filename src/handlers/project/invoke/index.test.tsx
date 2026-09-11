import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InvokeHarnessRequest } from "@aws-sdk/client-bedrock-agentcore";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { ProjectBackend, ResolveDeployedResourcesBackendInput } from "../../../core/project";
import { startHttpServer, type HttpServerHandle } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ExitCode, runWithExitCode } from "../../../runnable";
import { ProjectKey, ValueContext, type Context } from "../../../router";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  inTempDirectory,
} from "../../../testing";
import { createRootHandler } from "../../index";
import { JsonKey, RegionKey } from "../../keys";
import { RuntimeInvokeLaunchContextKey } from "../../runtime/invoke/launchContext";
import type { RuntimeInvokeRequest } from "../../runtime/types";
import type { Project } from "../types";
import { createProjectInvokeHandler } from ".";
import { createProjectInvokeHarnessHandler } from "./harness";
import { createProjectInvokeRuntimeHandler } from "./runtime";

const servers: HttpServerHandle[] = [];
const cleanups: Array<() => Promise<void>> = [];

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "eu-west-1",
} as const;
const RUNTIME_ID = "checkout-AbCdEf1234";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:runtime/${RUNTIME_ID}`;
const HARNESS_ID = "support-AbCdEf1234";
const HARNESS_ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:harness/${HARNESS_ID}`;
const RUNTIME = {
  name: "checkout",
  build: "CodeZip",
  entrypoint: "main.py",
  codeLocation: "app/checkout",
  runtimeVersion: "PYTHON_3_14",
} as const;
const HARNESS = { name: "support", path: "app/support" } as const;

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

async function inProject(
  resources: {
    runtimes?: unknown[];
    harnesses?: unknown[];
  },
  options: { writeTargets?: boolean } = {},
): Promise<void> {
  const { path: root, cleanup } = await inTempDirectory("agentcore-project-invoke-reduced-");
  cleanups.push(cleanup);
  await mkdir(join(root, "agentcore"), { recursive: true });
  const spec = ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    runtimes: resources.runtimes ?? [],
    harnesses: resources.harnesses ?? [],
  });
  await writeFile(join(root, "agentcore", "agentcore.json"), JSON.stringify(spec));
  if (options.writeTargets !== false) {
    await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify([TARGET]));
  }
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
      return [
        ...project.spec.runtimes.map(({ name }) => ({
          resourceType: "runtime" as const,
          name,
          id: RUNTIME_ID,
          target: input.target,
        })),
        ...project.spec.harnesses.map(({ name }) => ({
          resourceType: "harness" as const,
          name,
          id: HARNESS_ID,
          target: input.target,
        })),
      ];
    },
    async resolveProjectResources() {
      throw new Error("project invoke resolves deployed resources, not project resources");
    },
  };
  return { calls, value };
}

function configureCore(core: TestCoreClient): void {
  core.runtime
    .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
    .setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: body(Buffer.from("runtime response")),
    });
  core.harness
    .setGetResponse({
      harness: { harnessId: HARNESS_ID, harnessName: "support", arn: HARNESS_ARN },
    } as GetHarnessResponse)
    .setInvokeEvents(
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "harness response" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    );
}

async function run(
  args: string[],
  resources: { runtimes?: unknown[]; harnesses?: unknown[] },
  options: { writeTargets?: boolean } = {},
) {
  const subject = await routedCommand(args, resources, options);
  await subject.route();
  return subject;
}

async function routedCommand(
  args: string[],
  resources: { runtimes?: unknown[]; harnesses?: unknown[] },
  options: { writeTargets?: boolean } = {},
) {
  await inProject(resources, options);
  const resolved = backend();
  const core = new TestCoreClient({ backends: { CDK: resolved.value } });
  configureCore(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  const route = () => root.route(["node", "agentcore", "project", "invoke", ...args]);
  return { core, io, resolved, route };
}

function context(project: Project): Context {
  return ValueContext.EmptyContext()
    .withValue(ProjectKey, project)
    .withValue(JsonKey, false)
    .withValue(RegionKey, "us-east-1");
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("project invoke", () => {
  test("invokes a local Runtime directly without resolving project resources", async () => {
    let request:
      | {
          method: string;
          url: string;
          contentType: string | undefined;
          accept: string | undefined;
          sessionId: string | undefined;
          userId: string | undefined;
          body: string;
        }
      | undefined;
    const server = await startHttpServer((received) => {
      request = {
        method: received.method,
        url: received.url,
        contentType: header(received.headers["content-type"]),
        accept: header(received.headers.accept),
        sessionId: header(received.headers["x-amzn-bedrock-agentcore-runtime-session-id"]),
        userId: header(received.headers["x-amzn-bedrock-agentcore-runtime-user-id"]),
        body: received.body.toString(),
      };
      return {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: "local response",
      };
    });
    servers.push(server);
    const payload = '{"prompt":"hi"}';

    const { core, io, resolved } = await run(
      ["runtime", "--local", "--port", String(server.port), "--payload", payload],
      {},
      { writeTargets: false },
    );

    expect(request).toEqual({
      method: "POST",
      url: "/invocations",
      contentType: "application/json",
      accept: "text/event-stream",
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      userId: "default",
      body: payload,
    });
    expect(io.stdout()).toBe("local response");
    expect(io.stderr()).toContain(`runtime-session-id=${request?.sessionId}`);
    expect(resolved.calls).toEqual([]);
    expect(core.runtime.calls).toEqual([]);
  });

  test("forwards local HTTP Runtime request options", async () => {
    type CapturedHeaders = {
      contentType?: string;
      accept?: string;
      sessionId?: string;
      userId?: string;
      tenant?: string;
      traceId?: string;
      traceParent?: string;
      traceState?: string;
      baggage?: string;
    };
    let headers: CapturedHeaders | undefined;
    const expectedHeaders: CapturedHeaders = {
      contentType: "application/custom+json",
      accept: "application/json",
      sessionId: "local-session",
      userId: "local-user",
      tenant: "retail",
      traceId: "Root=1-local",
      traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      traceState: "tenant=retail",
      baggage: "tenant=retail",
    };
    const server = await startHttpServer((received) => {
      headers = {
        contentType: header(received.headers["content-type"]),
        accept: header(received.headers.accept),
        sessionId: header(received.headers["x-amzn-bedrock-agentcore-runtime-session-id"]),
        userId: header(received.headers["x-amzn-bedrock-agentcore-runtime-user-id"]),
        tenant: header(received.headers["x-tenant"]),
        traceId: header(received.headers["x-amzn-trace-id"]),
        traceParent: header(received.headers.traceparent),
        traceState: header(received.headers.tracestate),
        baggage: header(received.headers.baggage),
      };
      return { status: 204 };
    });
    servers.push(server);

    await run(
      [
        "runtime",
        "--local",
        "--port",
        String(server.port),
        "--payload",
        "{}",
        "--content-type",
        "application/custom+json",
        "--accept",
        "application/json",
        "--session-id",
        "local-session",
        "--user-id",
        "local-user",
        "--header",
        "X-Tenant: retail",
        "--trace-id",
        "Root=1-local",
        "--trace-parent",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "--trace-state",
        "tenant=retail",
        "--baggage",
        "tenant=retail",
      ],
      {},
      { writeTargets: false },
    );

    expect(headers).toEqual(expectedHeaders);
  });

  test("prints how to start project dev when the local Runtime is not running", async () => {
    const server = await startHttpServer(() => ({ status: 200 }));
    const port = server.port;
    await server.close();
    const errors: string[] = [];
    const errorLog = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });

    try {
      const code = await runWithExitCode(async () => {
        await run(
          ["runtime", "--local", "--port", String(port), "--payload", "{}"],
          {},
          { writeTargets: false },
        );
      });

      expect(code).toBe(ExitCode.FAILURE);
      expect(errors.join("\n")).toContain(`Could not reach local dev server on port ${port}`);
      expect(errors.join("\n")).toContain(
        `agentcore project dev --mode headless --agent <name> --port ${port}`,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  test("writes a local Runtime error response before exiting unsuccessfully", async () => {
    const server = await startHttpServer(() => ({
      status: 500,
      headers: { "Content-Type": "text/plain" },
      body: "local failure",
    }));
    servers.push(server);
    const subject = await routedCommand(
      ["runtime", "--local", "--port", String(server.port), "--payload", "{}"],
      {},
      { writeTargets: false },
    );

    const code = await runWithExitCode(subject.route);

    expect(code).toBe(ExitCode.FAILURE);
    expect(subject.io.stdout()).toBe("local failure");
    expect(subject.io.stderr()).toContain("status=500");
  });

  test.each([
    {
      name: "requires --local with --port",
      args: ["runtime", "--port", "8081", "--payload", "{}"],
      message: "--port requires --local",
    },
    {
      name: "rejects deployed-only flags locally",
      args: ["runtime", "--local", "--payload", "{}", "--target", "prod"],
      message: "--target cannot be used with --local",
    },
    {
      name: "requires a local payload",
      args: ["runtime", "--local"],
      message: "required option '--payload <payload>' not specified",
    },
  ])("$name", async ({ args, message }) => {
    await expect(run([...args], {}, { writeTargets: false })).rejects.toThrow(message);
  });

  test("invokes the sole Runtime with its existing payload contract in the target region", async () => {
    const payload = '{"custom":"wire shape"}';
    const { core, io, resolved } = await run(
      ["runtime", "--payload", payload, "--content-type", "application/custom+json"],
      { runtimes: [RUNTIME] },
    );

    const request = core.runtime.calls.find(({ method }) => method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(new TextDecoder().decode(request.payload)).toBe(payload);
    expect(request.contentType).toBe("application/custom+json");
    expect(request.runtimeUserId).toBe("default");
    expect(core.runtime.calls.at(-1)!.args[1]).toEqual({ region: TARGET.region });
    expect(io.stdout()).toBe("runtime response");
    expect(resolved.calls).toEqual([{ target: TARGET }]);
  });

  test("invokes a named Harness with its existing prompt contract in the target region", async () => {
    const { core, io } = await run(["harness", "--name", "support", "--prompt", "hello"], {
      harnesses: [HARNESS],
    });

    const request = core.harness.calls.find(({ method }) => method === "invokeHarness")!
      .args[0] as InvokeHarnessRequest;
    expect(request).toMatchObject({
      harnessArn: HARNESS_ARN,
      qualifier: "DEFAULT",
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });
    expect(core.harness.calls.at(-1)!.args[1]).toEqual({ region: TARGET.region });
    expect(JSON.parse(io.stdout()).transcript).toContainEqual({
      kind: "text",
      text: "harness response",
      streaming: false,
    });
  });

  test("requires --name when the project has multiple Runtimes", async () => {
    await expect(
      run(["runtime", "--payload", "{}"], {
        runtimes: [RUNTIME, { ...RUNTIME, name: "inventory" }],
      }),
    ).rejects.toThrow(/multiple Runtimes.*--name.*checkout, inventory/s);
  });

  test("opens the existing Runtime TUI for bare and TUI-compatible Runtime invokes", async () => {
    await inProject({ runtimes: [RUNTIME] });
    const resolved = backend();
    const core = new TestCoreClient({ backends: { CDK: resolved.value } });
    const project = await core.projectManager.resolve({ filePath: process.cwd() });
    const launches: { path: string; context: Context }[] = [];
    const handler = createProjectInvokeRuntimeHandler(core, testIO().io, async (path, ctx) => {
      launches.push({ path, context: ctx });
    });

    const bareFlags = {
      name: undefined,
      local: false,
      port: undefined,
      target: undefined,
      payload: undefined,
      qualifier: undefined,
      "content-type": undefined,
      accept: undefined,
      "session-id": undefined,
      "user-id": undefined,
      header: undefined,
      "bearer-token": undefined,
      "mcp-session-id": undefined,
      "mcp-protocol-version": undefined,
      "mcp-method": undefined,
      "mcp-name": undefined,
      "trace-id": undefined,
      "trace-parent": undefined,
      "trace-state": undefined,
      baggage: undefined,
      "output-file": undefined,
    };

    await handler.handle(context(project!), bareFlags, {});

    expect(launches[0]!.path).toBe(`/agentcore/runtime/invoke/${RUNTIME_ID}`);
    expect(launches[0]!.context.require(RegionKey)).toBe(TARGET.region);
    expect(launches[0]!.context.require(RuntimeInvokeLaunchContextKey)).toMatchObject({
      runtimeId: RUNTIME_ID,
    });

    await handler.handle(
      context(project!),
      {
        ...bareFlags,
        name: "checkout",
        target: "default",
        "session-id": "project-session",
      },
      {},
    );

    expect(launches[1]!.context.require(RuntimeInvokeLaunchContextKey)).toMatchObject({
      runtimeId: RUNTIME_ID,
      runtimeSessionId: "project-session",
    });
  });

  test("opens the existing Harness TUI with the resolved project Harness", async () => {
    await inProject({ harnesses: [HARNESS] });
    const resolved = backend();
    const core = new TestCoreClient({ backends: { CDK: resolved.value } });
    const project = await core.projectManager.resolve({ filePath: process.cwd() });
    const launches: { path: string; context: Context }[] = [];
    const handler = createProjectInvokeHarnessHandler(core, testIO().io, async (path, ctx) => {
      launches.push({ path, context: ctx });
    });

    await handler.handle(
      context(project!),
      {
        name: "support",
        target: "default",
        prompt: undefined,
        "session-id": undefined,
        qualifier: "prod",
      },
      {},
    );

    expect(launches[0]!.path).toBe(`/agentcore/harness/invoke/${HARNESS_ID}?qualifier=prod`);
    expect(launches[0]!.context.require(RegionKey)).toBe(TARGET.region);
  });

  test("bare project invoke opens the project resource picker", async () => {
    await inProject({ runtimes: [RUNTIME], harnesses: [HARNESS] });
    const core = new TestCoreClient();
    const project = await core.projectManager.resolve({ filePath: process.cwd() });
    const launches: string[] = [];
    const handler = createProjectInvokeHandler(core, testIO().io, async (path) => {
      launches.push(path);
    });

    await handler.defaultHandler()!.handle(context(project!), {}, {});

    expect(launches).toEqual(["/agentcore/project/invoke"]);
  });
});
