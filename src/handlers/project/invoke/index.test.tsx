import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  GetAgentRuntimeResponse,
  GetGatewayResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { ProjectBackend } from "../../../core/project";
import { ExitCode } from "../../../errors";
import { startHttpServer, type HttpServerHandle } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { runWithExitCode } from "../../../runnable";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  inTempDirectory,
  StreamController,
  tick,
  waitFor,
} from "../../../testing";
import * as tui from "../../../tui";
import { createRootHandler } from "../../index";
import { RegionKey } from "../../keys";

const servers: HttpServerHandle[] = [];
const cleanups: Array<() => Promise<void>> = [];

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "eu-west-1",
} as const;
const arn = (resource: string) =>
  `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:${resource}`;
const RUNTIME_ID = "checkout-AbCdEf1234";
const HARNESS_ID = "support-AbCdEf1234";
const GATEWAY_ID = "tools-AbCdEf1234";
const RUNTIME = {
  name: "checkout",
  build: "CodeZip",
  entrypoint: "main.py",
  codeLocation: "app/checkout",
  runtimeVersion: "PYTHON_3_14",
} as const;
const HARNESS = { name: "support", path: "app/support" } as const;
const GATEWAY = { name: "tools", targets: [] } as const;

type Resources = {
  runtimes?: readonly unknown[];
  harnesses?: readonly unknown[];
  agentCoreGateways?: readonly unknown[];
};

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

async function inProject(resources: Resources, options: { writeTargets?: boolean } = {}) {
  const { path: root, cleanup } = await inTempDirectory("agentcore-project-invoke-");
  cleanups.push(cleanup);
  await mkdir(join(root, "agentcore"), { recursive: true });
  const spec = ProjectSpecSchema.parse({ name: "orders", version: 2, ...resources });
  await writeFile(join(root, "agentcore", "agentcore.json"), JSON.stringify(spec));
  if (options.writeTargets !== false) {
    await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify([TARGET]));
  }
}

function backend() {
  const targets: string[] = [];
  const value: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield* [];
      return { outputs: {} };
    },
    async resolveDeployedResources() {
      throw new Error("invoke resolves project resources, not deployed resources");
    },
    async resolveProjectResources(project, input) {
      targets.push(input.target.name);
      return [
        ...project.spec.runtimes.map(({ name }) => ({
          resourceType: "runtime" as const,
          name,
          deploymentState: "deployed" as const,
          arn: arn(`runtime/${RUNTIME_ID}`),
        })),
        ...project.spec.harnesses.map(({ name }) => ({
          resourceType: "harness" as const,
          name,
          deploymentState: "deployed" as const,
          arn: arn(`harness/${HARNESS_ID}`),
        })),
        ...project.spec.agentCoreGateways.map(({ name }) => ({
          resourceType: "gateway" as const,
          name,
          deploymentState: "deployed" as const,
          arn: arn(`gateway/${GATEWAY_ID}`),
        })),
      ];
    },
  };
  return { targets, value };
}

async function routedCommand(
  args: readonly string[],
  resources: Resources | undefined,
  options: { writeTargets?: boolean; isTTY?: boolean } = {},
) {
  if (resources) {
    await inProject(resources, options);
  } else {
    cleanups.push((await inTempDirectory("agentcore-invoke-outside-")).cleanup);
  }
  const resolved = backend();
  const core = new TestCoreClient({ backends: { CDK: resolved.value } });
  core.runtime
    .setGetResponse({ agentRuntimeArn: arn(`runtime/${RUNTIME_ID}`) } as GetAgentRuntimeResponse)
    .setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: (async function* () {
        yield Buffer.from("runtime response");
      })(),
    });
  core.harness
    .setGetResponse({ harness: { arn: arn(`harness/${HARNESS_ID}`) } } as GetHarnessResponse)
    .setInvokeEvents(
      { messageStart: { role: "assistant" } },
      { messageStop: { stopReason: "end_turn" } },
    );
  core.gateway
    .setGetResponse({
      gatewayArn: arn(`gateway/${GATEWAY_ID}`),
      gatewayUrl: "https://tools.gateway.example.test/mcp",
      authorizerType: "NONE",
    } as GetGatewayResponse)
    .setInvokeResponse({
      statusCode: 200,
      contentType: "application/json",
      body: (async function* () {
        yield Buffer.from("gateway response");
      })(),
    });
  const io = testIO({ isTTY: options.isTTY });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  const route = () => root.route(["node", "agentcore", "invoke", ...args, "--region", "us-east-1"]);
  return { core, io, resolved, route };
}

async function run(
  args: readonly string[],
  resources: Resources | undefined,
  options: { writeTargets?: boolean } = {},
) {
  const subject = await routedCommand(args, resources, options);
  await subject.route();
  return subject;
}

async function launches(args: readonly string[], resources: Resources | undefined) {
  const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);
  try {
    const subject = await run(args, resources);
    return {
      ...subject,
      launches: render.mock.calls.map(([path, ctx]) => ({ path, region: ctx.value(RegionKey) })),
    };
  } finally {
    render.mockRestore();
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("invoke", () => {
  test.each([
    ["runtime", ["--runtime", "checkout", "--payload", "{}"], "runtime", "invokeRuntime"],
    ["harness", ["--harness", "support", "--prompt", "hi"], "harness", "invokeHarness"],
    [
      "gateway",
      ["--gateway", "tools", "--path", "/mcp", "--payload", "{}"],
      "gateway",
      "invokeGateway",
    ],
  ] as const)(
    "invokes a project %s by name in its deployed region",
    async (_type, args, client, method) => {
      const { core, resolved } = await run([...args], {
        runtimes: [RUNTIME],
        harnesses: [HARNESS],
        agentCoreGateways: [GATEWAY],
      });

      const invoke = core[client].calls.find((call) => call.method === method)!;
      expect(invoke.args[1]).toEqual({ region: TARGET.region });
      expect(resolved.targets).toEqual(["default"]);
    },
  );

  test.each([
    [["--runtime", "checkout"], `/agentcore/runtime/invoke/${RUNTIME_ID}`],
    [
      ["--harness", "support", "--qualifier", "prod"],
      `/agentcore/harness/invoke/${HARNESS_ID}?qualifier=prod`,
    ],
    [["--gateway", "tools"], `/agentcore/gateway/invoke/${GATEWAY_ID}`],
    [[], "/agentcore/invoke"],
  ])("opens the TUI for %j", async (args, path) => {
    const subject = await launches(args, {
      runtimes: [RUNTIME],
      harnesses: [HARNESS],
      agentCoreGateways: [GATEWAY],
    });

    expect(subject.launches).toEqual([
      { path, region: path === "/agentcore/invoke" ? "us-east-1" : TARGET.region },
    ]);
  });

  test.each([
    ["one resource", { runtimes: [RUNTIME] }],
    ["no project", undefined],
  ] as const)("a bare interactive invoke opens the picker with %s", async (_name, resources) => {
    const subject = await launches([], resources);

    expect(subject.launches.map((launch) => launch.path)).toEqual(["/agentcore/invoke"]);
  });

  test("a headless invoke selects the sole resource", async () => {
    const { core } = await run(["--payload", "{}"], { agentCoreGateways: [GATEWAY] });

    expect(core.gateway.calls.some(({ method }) => method === "invokeGateway")).toBe(true);
  });

  test("resolves the --target deployment target for project names", async () => {
    const { resolved } = await run(
      ["--runtime", "checkout", "--payload", "{}", "--target", "default"],
      {
        runtimes: [RUNTIME],
      },
    );

    expect(resolved.targets).toEqual(["default"]);
  });

  test.each([
    {
      name: "more than one resource flag",
      args: ["--runtime", "checkout", "--harness", "support"],
      resources: { runtimes: [RUNTIME], harnesses: [HARNESS] },
      message: "--runtime, --harness are mutually exclusive",
    },
    {
      name: "a bare --json invoke with several resources",
      args: ["--json"],
      resources: { runtimes: [RUNTIME], harnesses: [HARNESS] },
      message: "Choose a resource to invoke: --runtime checkout, --harness support.",
    },
    {
      name: "a bare --json invoke in an empty project",
      args: ["--json"],
      resources: {},
      message: "This project has no Runtimes, harnesses, or Gateways to invoke.",
    },
    {
      name: "a bare --json invoke outside a project",
      args: ["--json"],
      resources: undefined,
      message:
        "or any parent directory. Run from inside a project, or pass --runtime, --harness, or --gateway with an ID or ARN.",
    },
    {
      name: "a flag that belongs to another resource type",
      args: ["--runtime", "checkout", "--prompt", "hi"],
      resources: { runtimes: [RUNTIME] },
      message: "--prompt does not apply to a Runtime",
    },
    {
      name: "--local for a harness",
      args: ["--harness", "support", "--local"],
      resources: { harnesses: [HARNESS] },
      message: "--local does not apply to a Harness",
    },
    {
      name: "--target with an ID",
      args: ["--gateway", GATEWAY_ID, "--target", "default"],
      resources: { agentCoreGateways: [GATEWAY] },
      message: "--target only applies to project resources",
    },
    {
      name: "--local outside a project",
      args: ["--runtime", RUNTIME_ID, "--local", "--payload", "{}"],
      resources: undefined,
      message: "--local only applies to project resources",
    },
    {
      name: "a harness session ID that is too short",
      args: ["--harness", "support", "--prompt", "hi", "--session-id", "short"],
      resources: { harnesses: [HARNESS] },
      message: "Invalid value for option '--session-id'",
    },
  ])("rejects $name", async ({ args, resources, message }) => {
    const subject = await routedCommand(args, resources);

    await expect(subject.route()).rejects.toThrow(message);
  });

  test("reads stdin before progress, then hands off to the first local Runtime chunk", async () => {
    const stream = new StreamController<Uint8Array>();
    const server = await startHttpServer(() => ({
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: stream,
    }));
    servers.push(server);
    const subject = await routedCommand(
      ["--local", "--port", String(server.port), "--payload", "-"],
      { runtimes: [RUNTIME] },
      { isTTY: true },
    );
    const stdin = subject.io.io.stdin as unknown as PassThrough;
    const pending = subject.route();
    try {
      await waitFor(() => stdin.listenerCount("readable") > 0);
      stdin.write("{}");
      await tick(120);
      expect(subject.io.stderr()).toBe("");
      stdin.end();
      await waitFor(() => subject.io.stderr().includes("Invoking runtime..."));
      expect(subject.io.stdout()).toBe("");
      stream.emit(Buffer.from("first"));
      await waitFor(() => subject.io.stdout() === "first");
      const afterFirstChunk = subject.io.stderr();
      await tick(120);
      expect(subject.io.stderr()).toBe(afterFirstChunk);
    } finally {
      stdin.end();
      stream.emit(Buffer.from("second"));
      stream.end();
      await pending;
    }
    expect(subject.io.stdout()).toBe("firstsecond");
  });

  test("auto-selects the sole local Runtime without resolving deployed resources", async () => {
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
      ["--local", "--port", String(server.port), "--payload", payload],
      { runtimes: [RUNTIME] },
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
    expect(resolved.targets).toEqual([]);
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
        "--runtime",
        RUNTIME.name,
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
      { runtimes: [RUNTIME] },
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
          ["--runtime", RUNTIME.name, "--local", "--port", String(port), "--payload", "{}"],
          { runtimes: [RUNTIME] },
          { writeTargets: false },
        );
      });

      expect(code).toBe(ExitCode.FAILURE);
      expect(errors.join("\n")).toContain(`Could not reach local dev server on port ${port}`);
      expect(errors.join("\n")).toContain(
        `agentcore dev --mode headless --agent <name> --port ${port}`,
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
      ["--runtime", RUNTIME.name, "--local", "--port", String(server.port), "--payload", "{}"],
      { runtimes: [RUNTIME] },
      { writeTargets: false },
    );

    const code = await runWithExitCode(subject.route);

    expect(code).toBe(ExitCode.FAILURE);
    expect(subject.io.stdout()).toBe("local failure");
    expect(subject.io.stderr()).toContain("status=500");
  });

  test.each([
    ["HTTP", "checkout", undefined, "/invocations", "text/event-stream"],
    ["AG-UI", "assistant", "AGUI", "/invocations", "text/event-stream"],
    ["MCP", "tools", "MCP", "/mcp", "application/json, text/event-stream"],
    ["A2A", "peer", "A2A", "/", "text/event-stream"],
  ] as const)(
    "routes a named local %s Runtime to its protocol endpoint",
    async (_label, name, protocol, path, expectedAccept) => {
      let request:
        | {
            url: string;
            accept: string | undefined;
            mcpSessionId: string | undefined;
            mcpProtocolVersion: string | undefined;
            mcpMethod: string | undefined;
            mcpName: string | undefined;
          }
        | undefined;
      const server = await startHttpServer((received) => {
        request = {
          url: received.url,
          accept: header(received.headers.accept),
          mcpSessionId: header(received.headers["mcp-session-id"]),
          mcpProtocolVersion: header(received.headers["mcp-protocol-version"]),
          mcpMethod: header(received.headers["mcp-method"]),
          mcpName: header(received.headers["mcp-name"]),
        };
        return { status: 204 };
      });
      servers.push(server);
      const runtimes = [
        RUNTIME,
        { ...RUNTIME, name: "assistant", protocol: "AGUI" },
        { ...RUNTIME, name: "tools", protocol: "MCP" },
        { ...RUNTIME, name: "peer", protocol: "A2A" },
      ];
      const mcpArgs =
        protocol === "MCP"
          ? [
              "--mcp-session-id",
              "mcp-session",
              "--mcp-protocol-version",
              "2025-06-18",
              "--mcp-method",
              "tools/call",
              "--mcp-name",
              "weather",
            ]
          : [];

      await run(
        [
          "--runtime",
          name,
          "--local",
          "--port",
          String(server.port),
          "--payload",
          "{}",
          ...mcpArgs,
        ],
        { runtimes },
        { writeTargets: false },
      );

      expect(request).toEqual({
        url: path,
        accept: expectedAccept,
        mcpSessionId: protocol === "MCP" ? "mcp-session" : undefined,
        mcpProtocolVersion: protocol === "MCP" ? "2025-06-18" : undefined,
        mcpMethod: protocol === "MCP" ? "tools/call" : undefined,
        mcpName: protocol === "MCP" ? "weather" : undefined,
      });
    },
  );

  test.each([
    {
      name: "requires --local with --port",
      args: ["--port", "8081", "--payload", "{}"],
      message: "--port requires --local",
    },
    {
      name: "rejects deployed-only flags locally",
      args: ["--runtime", RUNTIME.name, "--local", "--payload", "{}", "--target", "prod"],
      message: "--target cannot be used with --local",
    },
    {
      name: "requires a local payload",
      args: ["--runtime", RUNTIME.name, "--local"],
      message: "required option '--payload <payload>' not specified",
    },
    {
      name: "rejects MCP options for a local non-MCP Runtime",
      args: ["--runtime", RUNTIME.name, "--local", "--payload", "{}", "--mcp-method", "tools/list"],
      message: "MCP options are only valid for MCP Runtimes",
    },
  ])("$name", async ({ args, message }) => {
    await expect(run([...args], { runtimes: [RUNTIME] }, { writeTargets: false })).rejects.toThrow(
      message,
    );
  });
});
