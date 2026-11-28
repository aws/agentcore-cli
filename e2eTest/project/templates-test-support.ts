import { expect } from "vitest";
import spawn from "cross-spawn";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX } from "../constants";
import { CliRunner, parseResult, type RunResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import { TIMEOUT_MS } from "../timeouts";

export type RuntimeTemplateTestCase = {
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
   * Runtime's logs for box starting it, and installs the AGENTCORE_E2E_BOX_CDK build to deploy it.
   * `agentcore dev` runs box on the protocol's fixed ingress port (8080, 8000 or 9000), so the
   * concurrent Runtime tests skip it; the sequential dev tests below cover it.
   */
  box?: boolean;
};

export const MCP_INITIALIZE_PAYLOAD = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agentcore-e2e", version: "1" },
  },
};
export const MCP_INITIALIZE_FLAGS = [
  "--accept",
  "application/json, text/event-stream",
  "--mcp-protocol-version",
  "2025-03-26",
  "--mcp-method",
  "initialize",
];
export const A2A_MESSAGE_PAYLOAD = {
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
export const AGUI_RUN_PAYLOAD = {
  threadId: "agentcore-e2e",
  runId: "agentcore-e2e",
  state: {},
  messages: [{ id: "agentcore-e2e", role: "user", content: "Reply with a short greeting." }],
  tools: [],
  context: [],
  forwardedProps: {},
};

/**
 * Whether a `box` runs from PATH. Create checks for it for a CodeZip box template, and build and
 * deploy of every Box template run `box profile show`, so the Box tests skip without one.
 */
export const BOX_ON_PATH = spawnSync("box", ["--version"], { stdio: "ignore" }).status === 0;

/** Whether a container tool that `agentcore dev` uses (docker, podman or finch) runs from PATH. */
export const CONTAINER_TOOL_ON_PATH = ["docker", "podman", "finch"].some(
  (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0,
);
/**
 * The opt-in for the Box tests that deploy: an `@aws/agentcore-cdk` version or `file:` tarball
 * that deploys Box projects, which the pinned release does not yet. It replaces the pin in each
 * Box project's agentcore/cdk/package.json, so with it unset (as in CI) those tests skip.
 */
export const BOX_CDK = process.env.AGENTCORE_E2E_BOX_CDK?.trim() || undefined;
/** Whether the Box tests that deploy run. */
export const BOX_DEPLOYS = BOX_CDK !== undefined && BOX_ON_PATH;

export const RUNTIME_TEMPLATES: RuntimeTemplateTestCase[] = [
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
  // deploy and invoke, not `agentcore dev`. They run only with the AGENTCORE_E2E_BOX_CDK opt-in.
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
      skip: !BOX_DEPLOYS,
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
export const BOX_TEMPLATES: RuntimeTemplateTestCase[] = [
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

export const ProjectCreatedSchema = z.object({
  project: z.object({ path: z.string() }),
});
export const OperationSchema = z.object({ operation: z.string() });
export const RuntimeInvokeResponseSchema = z.object({
  statusCode: z.number().int(),
  body: z.string(),
  bodyEncoding: z.string(),
  complete: z.boolean(),
});
export const LocalRuntimeInvokeResponseSchema = RuntimeInvokeResponseSchema.extend({
  statusCode: z.number().int().min(200).max(299),
  body: z.string().refine((value) => value.trim().length > 0, "response body must not be empty"),
  bodyEncoding: z.literal("utf8"),
  complete: z.literal(true),
});
export const DeployResponseSchema = z.object({ message: z.string() });
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown(),
  result: z.object({ protocolVersion: z.string() }),
  error: z.undefined().optional(),
});
export const A2aResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown(),
  result: z.object({ kind: z.literal("task") }),
  error: z.undefined().optional(),
});

/** The runtime `agentcore create --template` scaffolds (DEFAULT_CREATE_RUNTIME_NAME). */
export const CREATED_RUNTIME_NAME = "agent";
/** Keep concurrent local-dev processes off protocol defaults and one another. */
export const LOCAL_DEV_PORT_BASE = 18080;
/**
 * The port a box profile's ingress listens on, by protocol. Box `dev` must use it, so the box dev
 * tests run one at a time.
 */
export const BOX_DEV_PORTS = { HTTP: 8080, AGUI: 8080, MCP: 8000, A2A: 9000 } as const;

/** How long a dev-port lock may stand before a test takes it as left by a test process that died. */
const DEV_PORT_LOCK_STALE_MS = 20 * 60 * 1000;

/**
 * Runs `step` once no other test runs `agentcore dev` on `port`. Box listens on the protocol's fixed
 * ingress port, so two dev runs on one port cannot overlap; the rest of each test (build, deploy,
 * invoke) runs concurrently with the others. The test files run in separate processes, so the lock
 * is a directory in the temporary folder, which `mkdir` creates for one process only.
 */
export async function withDevPort<T>(port: number, step: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), `agentcore-e2e-dev-port-${port}.lock`);
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const since = await stat(lock).then(
        ({ mtimeMs }) => Date.now() - mtimeMs,
        () => 0,
      );
      if (since > DEV_PORT_LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  try {
    return await step();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// Every Box template deploys, the LangChain one too: the log check ignores the OpenTelemetry noise
// its agent logs at ERROR level (RUNTIME_LOG_NOISE).
export const DEPLOY_TEMPLATES = BOX_TEMPLATES;
// The templates that run the whole flow, dev before and after build and deploy in one project: one
// CodeZip and the container one. Each other template runs build and deploy here, and dev in its own
// test below, so its deploy does not wait for a dev step on the shared box ingress port.
export const FULL_FLOW_TEMPLATES = new Set([
  "agent-python-minimal-box",
  "agent-python-strands-box-container",
]);
export const fullFlow = (t: RuntimeTemplateTestCase) => FULL_FLOW_TEMPLATES.has(t.template);

// `agentcore dev` for each Strands Box template that the tests above do not run dev for: every
// template on a machine that cannot deploy Box projects (no AGENTCORE_E2E_BOX_CDK), and on one
// that can, each template outside FULL_FLOW_TEMPLATES and each one the deploy tests leave out. Box
// runs the agent on the developer's machine. Box listens on the protocol's fixed ingress port, so
// these tests run one at a time, and wait for the other dev steps on the same port. The container
// template's dev builds and runs its image, so it needs a container tool, which the CI macOS
// runner does not have (no nested virtualization). They need `box` on PATH and a machine where
// `box run` can start its sandbox.
export const DEV_ONLY_TEMPLATES = BOX_TEMPLATES.filter(
  (t) =>
    (CONTAINER_TOOL_ON_PATH || t.template !== "agent-python-strands-box-container") &&
    !(BOX_DEPLOYS && DEPLOY_TEMPLATES.includes(t) && fullFlow(t)),
);

// Egress from a boxed agent under `agentcore dev`: the box profile allows one host with no
// credential, and box blocks every other host. The agent is the minimal template with its code
// replaced, so no model call decides the result. The hosts are public, so the network can make
// this fail; it has its own tag, keeping it out of `--tagsFilter='box'`. Run it with
// `bun run test:e2e -- --tagsFilter='box-egress'`.
export const EGRESS_ALLOWED_URL = "https://checkip.amazonaws.com";
export const EGRESS_BLOCKED_URL = "https://example.com";
export const EGRESS_AGENT = `import urllib.request

from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return {"status": response.status}
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

@app.entrypoint
def invoke(payload, context):
    return {"allowed": fetch("${EGRESS_ALLOWED_URL}"), "blocked": fetch("${EGRESS_BLOCKED_URL}")}

if __name__ == "__main__":
    app.run()
`;
export const EgressReplySchema = z.object({
  allowed: z.object({ status: z.number().optional(), error: z.string().optional() }),
  blocked: z.object({ status: z.number().optional(), error: z.string().optional() }),
});

/**
 * The text of an invoke reply. A streamed reply is server-sent events, whose text arrives split
 * across `contentBlockDelta` events, so a word can span two of them; the text is their join. Any
 * other body is returned as it is.
 */
export function replyText(body: string): string {
  const deltas = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      try {
        const text = (
          JSON.parse(line.slice("data: ".length)) as {
            event?: { contentBlockDelta?: { delta?: { text?: unknown } } };
          }
        ).event?.contentBlockDelta?.delta?.text;
        return typeof text === "string" ? text : "";
      } catch {
        return "";
      }
    });
  return deltas.some((text) => text !== "") ? deltas.join("") : body;
}

/** The public host that answers with the request's headers, for the API key egress scenario. */
export const ECHO_URL = "https://httpbin.org/headers";
/** An agent that calls ECHO_URL with no credential of its own and returns the Authorization it saw. */
export const ECHO_AGENT = `import json
import urllib.request

from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    try:
        with urllib.request.urlopen("${ECHO_URL}", timeout=20) as response:
            headers = json.load(response).get("headers", {})
            return {"status": response.status, "authorization": headers.get("Authorization")}
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

if __name__ == "__main__":
    app.run()
`;

/**
 * An agent that writes the prompt as an event to the `notes` Memory, which `add memory` adds, and
 * returns the texts of the session's events that Memory gives back.
 */
export const MEMORY_AGENT = `import os
from datetime import datetime, timezone

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    try:
        memory = boto3.client("bedrock-agentcore")
        where = {
            "memoryId": os.environ["MEMORY_NOTES_ID"],
            "actorId": "e2e",
            "sessionId": context.session_id,
        }
        memory.create_event(
            **where,
            eventTimestamp=datetime.now(timezone.utc),
            payload=[{"conversational": {"content": {"text": payload["prompt"]}, "role": "USER"}}],
        )
        events = memory.list_events(**where, includePayloads=True)["events"]
        return {
            "stored": [
                part["conversational"]["content"]["text"]
                for event in events
                for part in event.get("payload", [])
                if "conversational" in part
            ]
        }
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

if __name__ == "__main__":
    app.run()
`;

/** Adds a connection to the AWS-managed tool `type` to the created runtime in agentcore.json. */
export async function addConnection(projectDir: string, type: "codeInterpreter" | "browser") {
  const specPath = join(projectDir, "agentcore", "agentcore.json");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as {
    runtimes: { name: string; connections?: { to: { type: string } }[] }[];
  };
  const runtime = spec.runtimes.find((entry) => entry.name === CREATED_RUNTIME_NAME);
  if (!runtime) throw new Error(`agentcore.json has no runtime ${CREATED_RUNTIME_NAME}`);
  runtime.connections = [...(runtime.connections ?? []), { to: { type } }];
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
}

/**
 * Lets the agent of `projectDir` open the Browser's automation WebSocket, as a user does: a
 * `policy.dw` beside the local profile permits `websocket:connect` to the AgentCore host of the
 * profile's region, on the browser stream paths only, and the profile lists it under `policies`.
 */
export async function allowBrowserWebSocket(projectDir: string): Promise<void> {
  const local = join(projectDir, ".box", CREATED_RUNTIME_NAME, "local");
  const profilePath = join(local, "profile.toml");
  const profile = await readFile(profilePath, "utf8");
  const region = /^bedrock\.region = "([a-z0-9-]+)"$/m.exec(profile)?.[1];
  if (!region) throw new Error(`${profilePath} names no bedrock.region`);
  const created = 'policies = ["aws-metadata-block.dw"]\n';
  if (!profile.includes(created)) throw new Error(`${profilePath} lacks ${created.trim()}`);
  await writeFile(
    join(local, "policy.dw"),
    '@id("browser_automation") permit (principal, action == Box::Action::"websocket:connect", resource)\n' +
      `when { context.input.host == "bedrock-agentcore.${region}.amazonaws.com" && ` +
      'context.input.path like "/browser-streams/*" };\n',
  );
  await writeFile(
    profilePath,
    profile.replace(created, 'policies = ["aws-metadata-block.dw", "policy.dw"]\n'),
  );
}

/** An agent that runs `print(6 * 7)` in the AWS-managed Code Interpreter and returns its output. */
export const CODE_INTERPRETER_AGENT = `import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()
TOOL = "aws.codeinterpreter.v1"

@app.entrypoint
def invoke(payload, context):
    try:
        client = boto3.client("bedrock-agentcore")
        session = client.start_code_interpreter_session(
            codeInterpreterIdentifier=TOOL, sessionTimeoutSeconds=300
        )["sessionId"]
        try:
            response = client.invoke_code_interpreter(
                codeInterpreterIdentifier=TOOL,
                sessionId=session,
                name="executeCode",
                arguments={"language": "python", "code": "print(6 * 7)"},
            )
            output = [
                item.get("text", "")
                for event in response["stream"]
                for item in event.get("result", {}).get("content", [])
            ]
            return {"output": "".join(output)}
        finally:
            client.stop_code_interpreter_session(codeInterpreterIdentifier=TOOL, sessionId=session)
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

if __name__ == "__main__":
    app.run()
`;

/**
 * An agent that starts a session of the AWS-managed Browser, sends the Chrome DevTools command
 * \`Browser.getVersion\` over its automation WebSocket, and returns the browser's product. The
 * WebSocket client is the standard library's, through the proxy that box gives the agent, so the
 * agent needs no package beyond the template's.
 */
export const BROWSER_AGENT = `import base64
import http.client
import json
import os
import ssl
import struct
import urllib.parse

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()
TOOL = "aws.browser.v1"

def devtools(url, message):
    target = urllib.parse.urlsplit(url)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    context = ssl.create_default_context()
    if proxy:
        via = urllib.parse.urlsplit(proxy)
        connection = http.client.HTTPSConnection(via.hostname, via.port, context=context, timeout=30)
        connection.set_tunnel(target.hostname, target.port or 443)
    else:
        connection = http.client.HTTPSConnection(target.hostname, target.port or 443, context=context, timeout=30)
    path = target.path + (f"?{target.query}" if target.query else "")
    connection.request(
        "GET",
        path,
        headers={
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode(),
            "Sec-WebSocket-Version": "13",
        },
    )
    response = connection.getresponse()
    if response.status != 101:
        raise RuntimeError(f"WebSocket handshake answered {response.status}: {response.read()[:300]!r}")
    data = json.dumps(message).encode()
    size = len(data)
    if size < 126:
        header = bytes([0x81, 0x80 | size])
    elif size < 65536:
        header = bytes([0x81, 0x80 | 126]) + struct.pack("!H", size)
    else:
        header = bytes([0x81, 0x80 | 127]) + struct.pack("!Q", size)
    mask = os.urandom(4)
    connection.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def exactly(count):
        chunk = response.fp.read(count)
        if len(chunk) < count:
            raise EOFError("the automation WebSocket closed")
        return chunk

    while True:
        first, second = exactly(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", exactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", exactly(8))[0]
        if second & 0x80:
            exactly(4)
        body = exactly(length)
        if first & 0x0F == 0x8:
            raise EOFError(f"the automation WebSocket closed: {body!r}")
        if first & 0x0F == 0x1:
            reply = json.loads(body)
            if reply.get("id") == message["id"]:
                return reply

@app.entrypoint
def invoke(payload, context):
    try:
        client = boto3.client("bedrock-agentcore")
        started = client.start_browser_session(browserIdentifier=TOOL, sessionTimeoutSeconds=300)
        session = started["sessionId"]
        try:
            url = started["streams"]["automationStream"]["streamEndpoint"]
            reply = devtools(url, {"id": 1, "method": "Browser.getVersion"})
            return {"product": reply["result"]["product"]}
        finally:
            client.stop_browser_session(browserIdentifier=TOOL, sessionId=session)
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

if __name__ == "__main__":
    app.run()
`;

/** A public MCP server with no authentication, for the gateway target of the gateway scenario. */
export const MCP_SERVER_URL = "https://knowledge-mcp.global.api.aws";

/**
 * An agent that lists the tools of the project gateway \`tools\` at the URL the runtime gets, with
 * no credential of its own: box sends the calls through the Box gateway, whose role signs them. It
 * opens an MCP session first (initialize), as an MCP client does, at the gateway's /mcp path,
 * which the URL variable leaves out, and returns the gateway's raw answer when a step has no
 * result, so a failure says what the gateway said.
 */
export const GATEWAY_AGENT = `import json
import os
import urllib.parse
import urllib.request

from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

def rpc(url, body, session=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode()
        session = response.headers.get("Mcp-Session-Id") or session
    if "id" not in body:
        return None, session, text
    messages = []
    for line in text.splitlines():
        if line.startswith("data:"):
            messages.append(json.loads(line[len("data:"):]))
    if not messages and text.strip():
        messages.append(json.loads(text))
    reply = next((m for m in messages if m.get("id") == body["id"]), None)
    return reply, session, text

@app.entrypoint
def invoke(payload, context):
    url = os.environ.get("AGENTCORE_GATEWAY_TOOLS_URL")
    if not url:
        names = sorted(name for name in os.environ if name.startswith("AGENTCORE_GATEWAY_"))
        return {"error": f"no AGENTCORE_GATEWAY_TOOLS_URL; the gateway variables are {names}"}
    # The variable holds the gateway's URL with no path; the gateway serves MCP at /mcp.
    if urllib.parse.urlsplit(url).path in ("", "/"):
        url = url.rstrip("/") + "/mcp"
    try:
        init, session, raw = rpc(url, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "e2e", "version": "1.0"},
            },
        })
        if not init or "result" not in init:
            return {"error": f"initialize answered {raw[:500]}"}
        rpc(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
        listed, _, raw = rpc(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session)
        if not listed or "result" not in listed:
            return {"error": f"tools/list answered {raw[:500]}"}
        return {"tools": [tool["name"] for tool in listed["result"]["tools"]]}
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code} from {url}: {error.read()[:500]!r}"}
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}

if __name__ == "__main__":
    app.run()
`;

/**
 * Gives the project in `projectDir` the egress agent, and allows its one host, with no credential,
 * in the runtime's local box profile, which build derives the AgentCore Runtime profile from.
 */
export async function useEgressAgent(projectDir: string): Promise<void> {
  await writeFile(join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"), EGRESS_AGENT);
  const profile = join(projectDir, ".box", CREATED_RUNTIME_NAME, "local", "profile.toml");
  const host = new URL(EGRESS_ALLOWED_URL).host;
  await writeFile(
    profile,
    `${await readFile(profile, "utf8")}\n[egress.checkip]\ndestinations = ["${host}"]\n`,
  );
}

/** Checks the egress agent's reply: the allowed host answers, and box refuses the other one. */
export function assertEgressReply(body: string): void {
  const reply = EgressReplySchema.parse(JSON.parse(body));
  expect(reply.allowed).toEqual({ status: 200 });
  expect(reply.blocked.error).toMatch(/403/);
}

/**
 * Given a deployed Box project, waits for the Runtime's logs to show that box started the agent,
 * then checks they show no box error. The logs arrive a little after the invoke, so it retries.
 */
/**
 * The synthesized stack of a Box project puts every file asset under the `strands-box/` S3 key (the
 * vended CDK app's bucketPrefix), and tags the image of each container runtime `strands-box-<hash>`
 * (the L3's image tag prefix), so the runtime's code or image URI shows that it belongs to a Strands
 * Box project. Reads `agentcore build`'s output in agentcore/cdk/cdk.out.
 */
export async function assertStrandsBoxAssets(projectDir: string): Promise<void> {
  const cdkOut = join(projectDir, "agentcore", "cdk", "cdk.out");
  const manifestFiles = (await readdir(cdkOut)).filter((file) => file.endsWith(".assets.json"));
  expect(manifestFiles.length).toBeGreaterThan(0);
  for (const file of manifestFiles) {
    const manifest = JSON.parse(await readFile(join(cdkOut, file), "utf-8")) as {
      files?: Record<string, { destinations: Record<string, { objectKey: string }> }>;
    };
    const keys = Object.values(manifest.files ?? {}).flatMap((asset) =>
      Object.values(asset.destinations).map((destination) => destination.objectKey),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(/^strands-box\//);
  }

  const spec = JSON.parse(
    await readFile(join(projectDir, "agentcore", "agentcore.json"), "utf-8"),
  ) as { runtimes: { build: string }[] };
  if (!spec.runtimes.some((runtime) => runtime.build === "Container")) return;
  const templates = (await readdir(cdkOut)).filter((file) => file.endsWith(".template.json"));
  const templateText = (
    await Promise.all(templates.map((file) => readFile(join(cdkOut, file), "utf-8")))
  ).join("\n");
  expect(templateText).toMatch(/:strands-box-[0-9a-f]{64}"/);
}

export async function assertRunsInBox(
  cli: CliRunner,
  projectDir: string,
  runtimeName: string = CREATED_RUNTIME_NAME,
): Promise<void> {
  const logs = (query: string) =>
    cli.run(
      ["logs", "runtime", "--name", runtimeName, "--since", "30m", "--query", query],
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
  // never logs. box logs `running profile` when it starts, before the invoke, so the check first
  // waits for a line the invoke itself writes, the agent server's access line for its POST, so
  // the invoke's own lines have reached CloudWatch when it looks for errors.
  await retry(
    async () => {
      const found = await logs('"POST /"');
      if (found.exitCode !== 0 || !found.stdout.includes("POST /")) {
        throw new Error(
          `the Runtime's logs show no request from the invoke yet.\nstdout: ${found.stdout}\nstderr: ${found.stderr}`,
        );
      }
      return found;
    },
    2 * 60 * 1000,
    10 * 1000,
  );
  const errors = await logs('?ERROR ?"blocked by egress control" ?AccessDenied');
  expect(errors.exitCode).toBe(0);
  const failures = errors.stdout
    .split("\n")
    .filter((line) => /ERROR|blocked by egress control|AccessDenied/.test(line))
    .filter((line) => !RUNTIME_LOG_NOISE.some((noise) => line.includes(noise)));
  expect(failures).toEqual([]);
}

/**
 * Runtime log lines at ERROR level that say nothing about the agent: OpenTelemetry's context
 * warning, which the LangChain agent logs when a span ends in another async context than it
 * started in, while the request itself succeeds.
 */
export const RUNTIME_LOG_NOISE = ["Failed to detach context"];

/** Deploys `projectDir`, runs `scenario`, and tears the stack down even when a step fails. */
export async function deployed(
  cli: CliRunner,
  projectDir: string,
  scenario: () => Promise<void>,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  let scenarioCompleted = false;
  try {
    const deployment = parseResult(
      DeployResponseSchema,
      await cli.run(["deploy", "--yes", "--json"], projectDir, env),
    );
    expect(deployment.message).toContain("deployed project");
    await scenario();
    scenarioCompleted = true;
  } finally {
    await tearDown(cli, projectDir, scenarioCompleted);
  }
}

/** Invokes runtime `name` of `projectDir` with `prompt` in `session`, and returns the reply. */
export async function ask(
  cli: CliRunner,
  projectDir: string,
  name: string,
  session: string,
  prompt: string,
): Promise<string> {
  const response = parseResult(
    RuntimeInvokeResponseSchema,
    await cli.run(
      [
        "invoke",
        "--runtime",
        name,
        "--session-id",
        session,
        "--payload",
        JSON.stringify({ prompt }),
        "--json",
      ],
      projectDir,
    ),
  );
  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  expect(response.body.trim()).not.toBe("");
  return replyText(response.body);
}

/**
 * Invokes the agent of `projectDir`, whose `main.py` a scenario replaced with one that calls a
 * component and answers in JSON, and checks the reply with `check`. Retried, since a component
 * the deploy just made can take a moment to answer.
 */
export async function askAgent<T extends { error?: string }>(
  cli: CliRunner,
  projectDir: string,
  session: string,
  prompt: string,
  check: (reply: T) => void,
): Promise<void> {
  await retry(
    async () => {
      const reply = JSON.parse(
        await ask(cli, projectDir, CREATED_RUNTIME_NAME, session, prompt),
      ) as T;
      expect(reply.error).toBeUndefined();
      check(reply);
    },
    3 * TIMEOUT_MS.PROJECT_INVOKE,
    15 * 1000,
  );
}

/** The timeout of a Box scenario that deploys a project once and removes it. */
export const DEPLOY_TEST_TIMEOUT =
  TIMEOUT_MS.PROJECT_CREATE +
  6 * TIMEOUT_MS.PROJECT_INVOKE +
  3 * TIMEOUT_MS.PROJECT_DEPLOY +
  TIMEOUT_MS.PROJECT_REMOVE;

/**
 * Removes every resource of `projectDir` and deploys, which deletes them, then checks both steps:
 * `remove all` emptied the spec and the deploy removed the project. After a failed scenario, a
 * cleanup failure is logged beside the scenario's error, which stays the test's failure.
 */
export async function tearDown(
  cli: CliRunner,
  projectDir: string,
  scenarioCompleted: boolean,
): Promise<void> {
  const removed = await cli.run(["remove", "all", "--yes", "--json"], projectDir);
  const cleanup = await cli.run(["deploy", "--yes", "--json"], projectDir);
  const check = () => {
    expect(parseResult(OperationSchema, removed).operation).toBe("remove");
    expect(parseResult(DeployResponseSchema, cleanup).message).toContain("removed project");
  };
  if (scenarioCompleted) return check();
  try {
    check();
  } catch (error) {
    console.error(`The cleanup of ${projectDir} failed too, so resources may remain:`, error);
  }
}

/** Six random lowercase letters and digits, for a project name. */
export function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Given a template test case, creates a project scaffolded from it and returns its path. A Box
 * project that `deploys` gets the AGENTCORE_E2E_BOX_CDK build; one that only runs `agentcore dev`
 * has no use for it.
 */
export async function createTemplateProject(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
  { deploys }: { deploys: boolean },
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agentcore-e2e-"));
  // A random suffix keeps concurrent projects (and their stacks) apart, also two of one template
  // that start in the same millisecond. Project names are alphanumeric, at most 23 characters.
  const projectName = `${E2E_PREFIX}${Date.now().toString(36)}${randomSuffix()}`;
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
  if (deploys && runtime.box && BOX_CDK) {
    // The pinned @aws/agentcore-cdk cannot deploy a Box project yet; use the opted-in build.
    const installed = await runCommand(
      "npm",
      ["install", "--no-audit", "--no-fund", `@aws/agentcore-cdk@${BOX_CDK}`],
      join(created.project.path, "agentcore", "cdk"),
    );
    if (installed.exitCode !== 0) {
      throw new Error(
        `npm could not install @aws/agentcore-cdk@${BOX_CDK} (AGENTCORE_E2E_BOX_CDK).\n` +
          `stdout: ${installed.stdout}\nstderr: ${installed.stderr}`,
      );
    }
  }
  return created.project.path;
}

/** Given a command, its arguments and a working directory, runs it and captures its result. */
export function runCommand(executable: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? -1 }));
  });
}

/**
 * Given a template test case, runs `agentcore dev` and invokes the runtime locally. Returns the
 * local invoke's response and everything dev printed.
 */
export async function invokeLocally(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
  projectDir: string,
  devPort: number,
): Promise<{ response: z.infer<typeof LocalRuntimeInvokeResponseSchema>; devOutput: string }> {
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
    return { response, devOutput };
  } finally {
    if (dev.exitCode === null) {
      dev.kill("SIGTERM");
      await new Promise<void>((resolve) => dev.once("close", resolve));
    }
  }
}

/**
 * Runs `agentcore dev` and `invoke --local` for a box template, once no other test runs dev on its
 * box ingress port, and checks that box ran the agent. The container template needs a container
 * tool for dev, so it skips the step without one.
 */
export async function devInBox(
  cli: CliRunner,
  runtime: RuntimeTemplateTestCase,
  projectDir: string,
): Promise<void> {
  if (!CONTAINER_TOOL_ON_PATH && runtime.template === "agent-python-strands-box-container") {
    console.warn(`${runtime.name}: no container tool on PATH, so the test skips agentcore dev`);
    return;
  }
  const port = BOX_DEV_PORTS[runtime.protocol];
  const { devOutput } = await withDevPort(port, () =>
    invokeLocally(cli, runtime, projectDir, port),
  );
  expect(devOutput).toContain("box: running profile");
}

/** Given a runtime and response body, validates the protocol response and request identifier. */
export function assertProtocolResponse(runtime: RuntimeTemplateTestCase, body: string): void {
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
export function getSessionId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`
    .replace(/[^a-z0-9]/gi, "")
    .padEnd(40, "x")
    .slice(0, 60);
}
