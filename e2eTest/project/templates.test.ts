import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX, TAGS } from "../constants";
import { CliRunner, parseResult, type RunResult } from "../helpers/run";
import { retry } from "../helpers/retry";

type RuntimeTemplateTestCase = {
  name: string;
  template: string;
  protocol: "HTTP" | "MCP" | "A2A" | "AGUI";
  payload: Record<string, unknown>;
  invokeFlags?: string[];
};

export const TIMEOUT_MS = {
  PROJECT_CREATE: 3 * 60 * 1000,
  PROJECT_DEV: 3 * 60 * 1000,
  PROJECT_DEPLOY: 10 * 60 * 1000,
  PROJECT_ADD: 3 * 60 * 1000,
  PROJECT_REMOVE: 60 * 1000,
  PROJECT_INVOKE: 3 * 60 * 1000,
};

const RUNTIME_TEMPLATES: RuntimeTemplateTestCase[] = [
  {
    name: "agent_python_minimal",
    template: "agent-python-minimal",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_strands",
    template: "agent-python-strands",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "py_strands_container",
    template: "agent-python-strands-container",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_langchain",
    template: "agent-python-langchain",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_ts_strands",
    template: "agent-typescript-strands",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_ts_vercel",
    template: "agent-typescript-vercel",
    protocol: "HTTP",
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "mcp_python_fastmcp",
    template: "mcp-python-fastmcp",
    protocol: "MCP",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agentcore-e2e", version: "1" },
      },
    },
    invokeFlags: [
      "--accept",
      "application/json, text/event-stream",
      "--mcp-protocol-version",
      "2025-03-26",
      "--mcp-method",
      "initialize",
    ],
  },
  {
    name: "a2a_python_strands",
    template: "a2a-python-strands",
    protocol: "A2A",
    payload: {
      jsonrpc: "2.0",
      id: "agentcore-e2e",
      method: "message/send",
      params: {
        message: {
          messageId: "agentcore-e2e",
          role: "user",
          parts: [{ kind: "text", text: "Reply with a short greeting." }],
        },
      },
    },
  },
  {
    name: "agui_python_strands",
    template: "agui-python-strands",
    protocol: "AGUI",
    payload: {
      threadId: "agentcore-e2e",
      runId: "agentcore-e2e",
      state: {},
      messages: [{ id: "agentcore-e2e", role: "user", content: "Reply with a short greeting." }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
  },
] as const;

const ProjectCreatedSchema = z.object({
  project: z.object({ path: z.string() }),
});
const OperationSchema = z.object({ operation: z.string() });
const RuntimeInvokeResponseSchema = z.object({
  statusCode: z.number().int(),
  body: z.string(),
  bodyEncoding: z.string(),
  complete: z.boolean(),
});
const LocalRuntimeInvokeResponseSchema = RuntimeInvokeResponseSchema.extend({
  statusCode: z.number().int().min(200).max(299),
  body: z.string().refine((value) => value.trim().length > 0, "response body must not be empty"),
  bodyEncoding: z.literal("utf8"),
  complete: z.literal(true),
});
const DeployResponseSchema = z.object({ message: z.string() });
const JsonObjectSchema = z.record(z.string(), z.unknown());
const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown(),
  result: z.object({ protocolVersion: z.string() }),
  error: z.undefined().optional(),
});
const A2aResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown(),
  result: z.object({ kind: z.literal("task") }),
  error: z.undefined().optional(),
});

describe(
  "add, dev, deploy, invoke for runtime templates",
  { sequential: true, tags: [TAGS.RUNTIME] },
  () => {
    const cli = new CliRunner();
    const projectName = `${E2E_PREFIX}${Date.now().toString(36)}`;
    let projectDir: string;

    beforeAll(async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "agentcore-e2e-"));
      const created = parseResult(
        ProjectCreatedSchema,
        await cli.run(
          [
            "project",
            "create",
            "--name",
            projectName,
            "--template",
            "empty",
            "--skip-git",
            "--json",
          ],
          projectRoot,
        ),
      );
      projectDir = created.project.path;
    }, TIMEOUT_MS.PROJECT_CREATE);

    test.each(RUNTIME_TEMPLATES)(
      "$name can be added to a project",
      { timeout: TIMEOUT_MS.PROJECT_CREATE },
      async (runtime) => {
        const added = parseResult(
          OperationSchema,
          await cli.run(
            [
              "project",
              "add",
              "runtime",
              "--name",
              runtime.name,
              "--template",
              runtime.template,
              "--json",
            ],
            projectDir,
          ),
        );
        expect(added.operation).toBe("add");
      },
    );

    describe("local invocation", { sequential: true }, () => {
      // invoke --local does not yet support MCP or A2A invocations
      const localRuntimes = RUNTIME_TEMPLATES.filter((runtime) =>
        ["HTTP", "AGUI"].includes(runtime.protocol),
      );
      const runtimePorts = new Map<string, number>();
      let dev: ReturnType<CliRunner["start"]> | undefined;
      let pendingOutput = "";

      /** Given dev-process output, records the ports announced by running runtimes. */
      const captureDevOutput = (chunk: Buffer) => {
        pendingOutput += chunk.toString();
        const lines = pendingOutput.split(/\r?\n/);
        pendingOutput = lines.pop() ?? "";

        // parse the out for the ports each agent is running on
        for (const line of lines) {
          const match = line.match(/Agent '([^']+)' is running on port (\d+)\./);
          if (match?.[1] && match[2]) runtimePorts.set(match[1], Number(match[2]));
        }
      };

      beforeAll(() => {
        dev = cli.start(["project", "dev", "--mode", "headless"], projectDir);
        dev.stdout?.on("data", captureDevOutput);
        dev.stderr?.on("data", captureDevOutput);
        dev.stdout?.resume();
        dev.stderr?.resume();
      }, TIMEOUT_MS.PROJECT_DEV);

      afterAll(async () => {
        if (!dev || dev.exitCode !== null) return;
        dev.kill("SIGTERM");
        await new Promise<void>((resolve) => dev?.once("close", resolve));
      });

      test.each(localRuntimes)(
        "$name runs locally",
        { concurrent: true, timeout: TIMEOUT_MS.PROJECT_INVOKE },
        async (runtime) => {
          const sessionId = getSessionId(`${runtime.name}`);

          // the server may take a bit to get ready, so we retry on a timeout.
          const response = await retry(async () => {
            if (!dev) throw new Error("project dev did not start.");
            if (dev.exitCode !== null)
              throw new Error(`project dev exited with code ${dev.exitCode ?? "unknown"}.`);

            const port = runtimePorts.get(runtime.name);
            if (!port) throw new Error(`Runtime '${runtime.name}' is not ready.`);

            return parseResult(
              LocalRuntimeInvokeResponseSchema,
              await cli.run(
                [
                  "project",
                  "invoke",
                  "runtime",
                  "--local",
                  "--port",
                  String(port),
                  "--session-id",
                  sessionId,
                  "--payload",
                  JSON.stringify(runtime.payload),
                  "--json",
                ],
                projectDir,
              ),
            );
          });

          expect(response.body.trim()).not.toBe("");
        },
      );
    });

    test("deploys all runtimes", { timeout: TIMEOUT_MS.PROJECT_DEPLOY }, async () => {
      const deployment = parseResult(
        DeployResponseSchema,
        await cli.run(["project", "deploy", "--yes", "--json"], projectDir),
      );
      expect(deployment.message).toContain("Deployed project");
    });

    test.each(RUNTIME_TEMPLATES)(
      "$name can be invoked after deployed",
      { concurrent: true, timeout: TIMEOUT_MS.PROJECT_INVOKE },
      async (runtime) => {
        const sessionId = getSessionId(runtime.name);
        const response = parseResult(
          RuntimeInvokeResponseSchema,
          await cli.run(
            [
              "project",
              "invoke",
              "runtime",
              "--name",
              runtime.name,
              "--session-id",
              sessionId,
              "--payload",
              JSON.stringify(runtime.payload),
              "--json",
              ...(runtime.invokeFlags ?? []),
            ],
            projectDir,
          ),
        );

        expect(response.complete).toBe(true);
        if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
          assertProtocolResponse(runtime, response.body);
        }
      },
    );

    test.each(RUNTIME_TEMPLATES)(
      "$name can be removed from the project",
      { timeout: TIMEOUT_MS.PROJECT_REMOVE },
      async (runtime) => {
        const removed = parseResult(
          OperationSchema,
          await cli.run(
            ["project", "remove", "runtime", "--name", runtime.name, "--json"],
            projectDir,
          ),
        );
        expect(removed.operation).toBe("remove");
      },
    );

    test(
      "deploys the empty project",
      { timeout: TIMEOUT_MS.PROJECT_REMOVE + TIMEOUT_MS.PROJECT_DEPLOY },
      async () => {
        parseResult(
          JsonObjectSchema,
          await cli.run(["project", "remove", "all", "--yes", "--json"], projectDir),
        );

        parseResult(
          JsonObjectSchema,
          await cli.run(["project", "deploy", "--yes", "--json"], projectDir),
        );
      },
    );
  },
);

/** Given a runtime and response body, validates the protocol response and request identifier. */
function assertProtocolResponse(runtime: RuntimeTemplateTestCase, body: string): void {
  const data = body
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  // convert parsed text back into a result to that we can parse it.
  const result: RunResult = {
    stdout: data ?? body,
    stderr: "",
    exitCode: 0,
  };

  if (runtime.protocol === "MCP") {
    const response = parseResult(McpResponseSchema, result);
    expect(response.id).toBe(runtime.payload.id);
    expect(response.error).toBe(undefined);
    return;
  }

  if (runtime.protocol === "A2A") {
    const response = parseResult(A2aResponseSchema, result);
    expect(response.id).toBe(runtime.payload.id);
    expect(response.error).toBe(undefined);
  }
}

/** Given a prefix, returns a sanitized AgentCore-compatible session identifier. */
function getSessionId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`
    .replace(/[^a-z0-9]/gi, "")
    .padEnd(40, "x")
    .slice(0, 60);
}
