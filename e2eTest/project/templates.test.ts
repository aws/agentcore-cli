import { describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX, TAGS } from "../constants";
import { CliRunner, parseResult, type RunResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import { TIMEOUT_MS } from "../timeouts";

type RuntimeTemplateTestCase = {
  name: string;
  template: string;
  protocol: "HTTP" | "MCP" | "A2A" | "AGUI";
  payload: Record<string, unknown>;
  invokeFlags?: string[];
  skip?: boolean;
};

const RUNTIME_TEMPLATES: RuntimeTemplateTestCase[] = [
  {
    name: "agent_python_minimal",
    template: "agent-python-minimal",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_strands",
    template: "agent-python-strands",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "py_strands_container",
    template: "agent-python-strands-container",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
    // Note: GH actions mac runners do not come with docker installed and does not allow nested virtualization (https://docs.github.com/en/actions/reference/runners/github-hosted-runners#limitations-for-arm64-macos-runners)
    // windows are also unable to run the linux container without a vm.
    skip: process.env.CI === "true" && process.platform !== "linux",
  },
  {
    name: "agent_python_langchain",
    template: "agent-python-langchain",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_ts_strands",
    template: "agent-typescript-strands",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_ts_vercel",
    template: "agent-typescript-vercel",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "mcp_python_fastmcp",
    template: "mcp-python-fastmcp",
    protocol: "MCP" as const,
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
    protocol: "A2A" as const,
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
    protocol: "AGUI" as const,
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
].filter((r) => !r.skip);

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

/** The runtime `agentcore create --template` scaffolds (DEFAULT_CREATE_RUNTIME_NAME). */
const CREATED_RUNTIME_NAME = "agent";

// Each template gets its own project from `agentcore create --template`, the
// command that scaffolds template code (`add runtime` only writes docs). The
// projects are independent, so the templates run concurrently; each one's
// steps run in order inside its test.
describe(
  "create, dev, deploy, invoke for runtime templates",
  { tags: [TAGS.RUNTIME, TAGS.CANARY] },
  () => {
    const cli = new CliRunner();

    test.concurrent.each(RUNTIME_TEMPLATES)(
      "$name",
      {
        timeout:
          TIMEOUT_MS.PROJECT_CREATE +
          TIMEOUT_MS.PROJECT_DEV +
          2 * TIMEOUT_MS.PROJECT_INVOKE +
          2 * TIMEOUT_MS.PROJECT_DEPLOY +
          TIMEOUT_MS.PROJECT_REMOVE,
      },
      async (runtime) => {
        const projectDir = await createTemplateProject(cli, runtime);
        try {
          await invokeLocally(cli, runtime, projectDir);

          const deployment = parseResult(
            DeployResponseSchema,
            await cli.run(["deploy", "--yes", "--json"], projectDir),
          );
          expect(deployment.message).toContain("Deployed project");

          const response = parseResult(
            RuntimeInvokeResponseSchema,
            await cli.run(
              [
                "invoke",
                "--runtime",
                CREATED_RUNTIME_NAME,
                "--session-id",
                getSessionId(runtime.name),
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

          const removed = parseResult(
            OperationSchema,
            await cli.run(
              ["remove", "runtime", "--name", CREATED_RUNTIME_NAME, "--json"],
              projectDir,
            ),
          );
          expect(removed.operation).toBe("remove");
        } finally {
          // Tear the stack down even when a step above failed.
          await cli.run(["remove", "all", "--yes", "--json"], projectDir);
          parseResult(JsonObjectSchema, await cli.run(["deploy", "--yes", "--json"], projectDir));
        }
      },
    );
  },
);

/** Given a template test case, creates a project scaffolded from it and returns its path. */
async function createTemplateProject(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agentcore-e2e-"));
  // A per-template suffix keeps concurrent projects (and their stacks) apart;
  // project names are alphanumeric, so it is the template's index.
  const projectName = `${E2E_PREFIX}${Date.now().toString(36)}t${RUNTIME_TEMPLATES.indexOf(runtime)}`;
  const created = parseResult(
    ProjectCreatedSchema,
    await cli.run(
      ["create", "--name", projectName, "--template", runtime.template, "--skip-git", "--json"],
      parent,
    ),
  );
  return created.project.path;
}

/** Given a template test case, runs `agentcore dev` and invokes the runtime locally. */
async function invokeLocally(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
  projectDir: string,
): Promise<void> {
  let port: number | undefined;
  let pendingOutput = "";
  let devOutput = "";
  /** Given dev-process output, records the port the runtime announces. */
  const captureDevOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    devOutput += text;
    pendingOutput += text;
    const lines = pendingOutput.split(/\r?\n/);
    pendingOutput = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/Agent '([^']+)' is running on port (\d+)\./);
      if (match?.[1] === CREATED_RUNTIME_NAME && match[2]) port = Number(match[2]);
    }
  };

  const dev = cli.start(["dev", "--mode", "headless"], projectDir);
  dev.stdout?.on("data", captureDevOutput);
  dev.stderr?.on("data", captureDevOutput);
  dev.stdout?.resume();
  dev.stderr?.resume();
  try {
    // The server may take a bit to get ready, so we retry on a timeout.
    const response = await retry(async () => {
      if (dev.exitCode !== null) {
        throw new Error(
          `agentcore dev exited with code ${dev.exitCode ?? "unknown"}.  \nstdout/stderr = ${devOutput}`,
        );
      }
      if (!port) {
        throw new Error(`Runtime '${runtime.name}' is not ready. \nstdout/stderr = ${devOutput}`);
      }
      return parseResult(
        LocalRuntimeInvokeResponseSchema,
        await cli.run(
          [
            "invoke",
            "--runtime",
            CREATED_RUNTIME_NAME,
            "--local",
            "--port",
            String(port),
            "--session-id",
            getSessionId(runtime.name),
            "--payload",
            JSON.stringify(runtime.payload),
            "--json",
            ...(runtime.invokeFlags ?? []),
          ],
          projectDir,
        ),
      );
    }, TIMEOUT_MS.PROJECT_INVOKE * 0.9);

    expect(response.complete).toBe(true);
    if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
      assertProtocolResponse(runtime, response.body);
    }
  } finally {
    if (dev.exitCode === null) {
      dev.kill("SIGTERM");
      await new Promise<void>((resolve) => dev.once("close", resolve));
    }
  }
}

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
