import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  /** Skips the `agentcore dev` step and its local invoke; deploy and the remote invoke still run. */
  skipDev?: boolean;
  /** The runtime's runtimeVersion, written into agentcore.json after create; the template's otherwise. */
  runtimeVersion?: string;
  skip?: boolean;
  /**
   * A Strands Box template: it runs its agent in a box on AgentCore Runtime, so the test checks the
   * Runtime's logs for box starting it. Create needs `box` on PATH.
   */
  box?: boolean;
};

const MCP_INITIALIZE_PAYLOAD = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agentcore-e2e", version: "1" },
  },
};
const MCP_INITIALIZE_FLAGS = [
  "--accept",
  "application/json, text/event-stream",
  "--mcp-protocol-version",
  "2025-03-26",
  "--mcp-method",
  "initialize",
];
const A2A_MESSAGE_PAYLOAD = {
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
};
const AGUI_RUN_PAYLOAD = {
  threadId: "agentcore-e2e",
  runId: "agentcore-e2e",
  state: {},
  messages: [{ id: "agentcore-e2e", role: "user", content: "Reply with a short greeting." }],
  tools: [],
  context: [],
  forwardedProps: {},
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
  // The box templates run their agent in Strands Box on AgentCore Runtime; the cases test create,
  // deploy and invoke, not `agentcore dev`. CI deploys with the released @aws/agentcore-cdk, which
  // has no Box support yet, so they run only outside CI for now.
  // The CodeZip box template on each other Python the CodeZip Runtime supports; it defaults to 3.14,
  // which the Box describe below covers, as it does the box container template.
  ...(["PYTHON_3_10", "PYTHON_3_11", "PYTHON_3_12", "PYTHON_3_13"] as const).map(
    (runtimeVersion) => ({
      name: `py_strands_box_${runtimeVersion.slice("PYTHON_".length)}`,
      template: "agent-python-strands-box",
      protocol: "HTTP" as const,
      payload: { prompt: "Reply with a short greeting." },
      skipDev: true,
      runtimeVersion,
      box: true,
      // CI deploys with the released @aws/agentcore-cdk, which has no Box support, and has no box.
      skip: process.env.CI === "true",
    }),
  ),
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
    payload: MCP_INITIALIZE_PAYLOAD,
    invokeFlags: MCP_INITIALIZE_FLAGS,
  },
  {
    name: "a2a_python_strands",
    template: "a2a-python-strands",
    protocol: "A2A" as const,
    payload: A2A_MESSAGE_PAYLOAD,
  },
  {
    name: "agui_python_strands",
    template: "agui-python-strands",
    protocol: "AGUI" as const,
    payload: AGUI_RUN_PAYLOAD,
  },
].filter((r) => !r.skip);

/**
 * The Strands Box templates, which run their agent in a box on AgentCore Runtime. The describe's
 * `skipIf` is their only skip: a `skip` on an entry here has no effect.
 */
const BOX_TEMPLATES: RuntimeTemplateTestCase[] = [
  {
    name: "agent_python_minimal_box",
    template: "agent-python-minimal-box",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_strands_box",
    template: "agent-python-strands-box",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_strands_box_container",
    template: "agent-python-strands-box-container",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "agent_python_langchain_box",
    template: "agent-python-langchain-box",
    protocol: "HTTP" as const,
    payload: { prompt: "Reply with a short greeting." },
  },
  {
    name: "mcp_python_fastmcp_box",
    template: "mcp-python-fastmcp-box",
    protocol: "MCP" as const,
    payload: MCP_INITIALIZE_PAYLOAD,
    invokeFlags: MCP_INITIALIZE_FLAGS,
  },
  {
    name: "a2a_python_strands_box",
    template: "a2a-python-strands-box",
    protocol: "A2A" as const,
    payload: A2A_MESSAGE_PAYLOAD,
  },
  {
    name: "agui_python_strands_box",
    template: "agui-python-strands-box",
    protocol: "AGUI" as const,
    payload: AGUI_RUN_PAYLOAD,
  },
].map((template) => ({ ...template, box: true }));

/** Every template the suite creates, so each project gets its own name. */
const ALL_TEMPLATES = [...RUNTIME_TEMPLATES, ...BOX_TEMPLATES];

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
/** Keep concurrent local-dev processes off protocol defaults and one another. */
const LOCAL_DEV_PORT_BASE = 18080;

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
        let scenarioCompleted = false;
        try {
          if (!runtime.skipDev) {
            await invokeLocally(
              cli,
              runtime,
              projectDir,
              LOCAL_DEV_PORT_BASE + RUNTIME_TEMPLATES.indexOf(runtime),
            );
          }

          const deployment = parseResult(
            DeployResponseSchema,
            await cli.run(["deploy", "--yes", "--json"], projectDir),
          );
          expect(deployment.message).toContain("deployed project");

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
          // As locally: an agent that failed to start answers with an error status or nothing.
          expect(response.statusCode).toBeGreaterThanOrEqual(200);
          expect(response.statusCode).toBeLessThan(300);
          expect(response.body.trim()).not.toBe("");
          if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
            assertProtocolResponse(runtime, response.body);
          }
          if (runtime.box) await assertRunsInBox(cli, projectDir);

          const removed = parseResult(
            OperationSchema,
            await cli.run(
              ["remove", "runtime", "--name", CREATED_RUNTIME_NAME, "--json"],
              projectDir,
            ),
          );
          expect(removed.operation).toBe("remove");
          scenarioCompleted = true;
        } finally {
          // Tear the stack down even when a step above failed.
          await cli.run(["remove", "all", "--yes", "--json"], projectDir);
          const cleanup = await cli.run(["deploy", "--yes", "--json"], projectDir);
          // A cleanup error must not replace the scenario's primary diagnostic.
          if (scenarioCompleted) parseResult(JsonObjectSchema, cleanup);
        }
      },
    );
  },
);

// The Strands Box templates run their agent in a box on AgentCore Runtime, so these tests create,
// deploy and invoke each one, then check that the Runtime started the agent in a box. They skip
// `agentcore dev`. They need `box` on PATH: create checks for it. Run them with
// `bun run test:e2e -- --tagsFilter='box'`. CI skips them: it deploys with the released
// @aws/agentcore-cdk, which has no Box support, and has no box on PATH.
describe.skipIf(process.env.CI === "true")(
  "create, deploy, invoke for Strands Box templates",
  { tags: [TAGS.RUNTIME, TAGS.BOX] },
  () => {
    const cli = new CliRunner();

    test.concurrent.each(BOX_TEMPLATES)(
      "$name",
      {
        timeout:
          TIMEOUT_MS.PROJECT_CREATE +
          2 * TIMEOUT_MS.PROJECT_INVOKE +
          2 * TIMEOUT_MS.PROJECT_DEPLOY +
          TIMEOUT_MS.PROJECT_REMOVE,
      },
      async (runtime) => {
        const projectDir = await createTemplateProject(cli, runtime);
        let scenarioCompleted = false;
        try {
          const deployment = parseResult(
            DeployResponseSchema,
            await cli.run(["deploy", "--yes", "--json"], projectDir),
          );
          expect(deployment.message).toContain("deployed project");

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
          // An agent that box started but that failed answers with an error status or nothing.
          expect(response.statusCode).toBeGreaterThanOrEqual(200);
          expect(response.statusCode).toBeLessThan(300);
          expect(response.body.trim()).not.toBe("");
          if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
            assertProtocolResponse(runtime, response.body);
          }

          await assertRunsInBox(cli, projectDir);
          scenarioCompleted = true;
        } finally {
          // Tear the stack down even when a step above failed.
          await cli.run(["remove", "all", "--yes", "--json"], projectDir);
          const cleanup = await cli.run(["deploy", "--yes", "--json"], projectDir);
          // A cleanup error must not replace the scenario's primary diagnostic.
          if (scenarioCompleted) parseResult(JsonObjectSchema, cleanup);
        }
      },
    );
  },
);

/**
 * Given a deployed Box project, waits for the Runtime's logs to show that box started the agent,
 * then checks they show no box error. The logs arrive a little after the invoke, so it retries.
 */
async function assertRunsInBox(cli: CliRunner, projectDir: string): Promise<void> {
  const logs = (query: string) =>
    cli.run(
      ["logs", "runtime", "--name", CREATED_RUNTIME_NAME, "--since", "30m", "--query", query],
      projectDir,
    );
  await retry(
    async () => {
      const found = await logs('"running profile"');
      if (found.exitCode !== 0 || !found.stdout.includes("running profile")) {
        throw new Error(
          `the Runtime's logs do not show box running the agent.\nstdout: ${found.stdout}\nstderr: ${found.stderr}`,
        );
      }
      return found;
    },
    2 * 60 * 1000,
    10 * 1000,
  );
  // `--query` is a CloudWatch filter pattern, so it returns only the matching events: the error
  // lines need their own query. These are the ones the root README.md says a working box agent
  // never logs. box logs `running profile` when it starts, before the invoke, so the check waits
  // for log lines from the invoke to reach CloudWatch first.
  await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
  const errors = await logs('?ERROR ?"blocked by egress control" ?AccessDenied');
  expect(errors.exitCode).toBe(0);
  expect(errors.stdout).not.toMatch(/ERROR|blocked by egress control|AccessDenied/);
}

/** Given a template test case, creates a project scaffolded from it and returns its path. */
async function createTemplateProject(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agentcore-e2e-"));
  // A per-template suffix keeps concurrent projects (and their stacks) apart;
  // project names are alphanumeric, so it is the template's index.
  const projectName = `${E2E_PREFIX}${Date.now().toString(36)}t${ALL_TEMPLATES.indexOf(runtime)}`;
  const created = parseResult(
    ProjectCreatedSchema,
    await cli.run(
      ["create", "--name", projectName, "--template", runtime.template, "--skip-git", "--json"],
      parent,
    ),
  );
  if (runtime.runtimeVersion) {
    const specPath = join(created.project.path, "agentcore", "agentcore.json");
    const spec = JSON.parse(await readFile(specPath, "utf8")) as {
      runtimes: { runtimeVersion?: string }[];
    };
    for (const entry of spec.runtimes) entry.runtimeVersion = runtime.runtimeVersion;
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  }
  return created.project.path;
}

/** Given a template test case, runs `agentcore dev` and invokes the runtime locally. */
async function invokeLocally(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
  projectDir: string,
  devPort: number,
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

  const dev = cli.start(["dev", "--mode", "headless", "--port", String(devPort)], projectDir);
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
