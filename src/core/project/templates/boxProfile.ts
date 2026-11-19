import { join, posix } from "node:path";
import { BOX_GATEWAY_BEDROCK_REGION, callsBedrockModel } from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { memoryEnvVarName } from "../../../projectSchemas/memory";
import { boxGatewayName, isBoxProject, type ProjectSpec } from "../../../projectSchemas/project";
import { DEFAULT_MODEL_IDS, type ProjectRuntime } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";
import { PYTHON_ENV } from "../../dev/codezip";
import type { BoxNetwork, BoxNetworkSource, CloudWatchTelemetry } from "../boxNetwork";
import { BOX_DEFERRED_INGRESS_PORT, boxRuntimeMounts, type BoxRuntimeMount } from "../boxRuntime";
import { modelProviderCredentialName } from "./runtime";

/** Where uv installs the Pythons it manages, as a boxy path. */
const UV_PYTHON_INSTALL_DIR = "${{ home }}/.local/share/uv/python";

/** The system libraries of the Linux arm64 image, such as libssl. */
const LINUX_LIBRARIES = "/usr/lib/aarch64-linux-gnu";

/**
 * The entry point of a runtime that runs its agent in a box on a CodeZip
 * deploy: start.py prepares the generated profile and starts Box. Create writes the launcher.
 */
export const BOX_CODEZIP_ENTRYPOINT = "start.py";

/** The folder deploy stages box into, inside the runtime's code folder, so it ships in the zip. */
export const BOX_CODEZIP_DIST = ".box-dist";

/**
 * The env vars the Runtime profile reads through its generated packs, so no start script fills the
 * profile in. The Runtime sets the gateway URL; start.py exports the CodeZip Python and code paths,
 * which only the microVM knows.
 */
const BOX_GATEWAY_URL_ENV = "AGENTCORE_GATEWAY_BOX_URL";
const BOX_PYTHON_ENV = "BOX_PYTHON";
const BOX_PYTHON_PREFIX_ENV = "BOX_PYTHON_PREFIX";
const BOX_CODE_ENV = "BOX_CODE";

/** The generated pack both Runtime profiles import for the deployed resources: {@link renderAgentCorePack}. */
export const AGENTCORE_PACK_NAME = "box/agentcore";
export const AGENTCORE_PACK_PATH = "resources/packs/agentcore/pack.toml";

/** The generated pack the CodeZip Runtime profile adds for the Runtime Python and code: {@link renderAgentCoreCodeZipPack}. */
export const AGENTCORE_CODEZIP_PACK_NAME = "box/agentcore-codezip";
export const AGENTCORE_CODEZIP_PACK_PATH = "resources/packs/agentcore-codezip/pack.toml";

/**
 * Bounds the `gateway.url` input: an `https` host under `amazonaws.com`. box requires a `pattern` or
 * `values` on an input that reaches a backend `url`, so a value from the environment names only the
 * host the profile expects. `[.]` matches a literal dot (a TOML basic string rejects `\.`).
 */
const GATEWAY_URL_PATTERN = "https://[a-z0-9][-a-z0-9.]*[.]amazonaws[.]com";

/**
 * Bounds an input that reaches the agent `command` (the Python path and the code dir): an absolute
 * path of safe characters, so a value from the environment cannot inject other arguments.
 */
const ABSOLUTE_PATH_PATTERN = "/[A-Za-z0-9_.+/-]+";

/**
 * The credential Box signs AWS routes with on AgentCore Runtime: a bare `aws://`, the AWS default
 * credential chain, which signs with the execution role and needs no credentials step.
 */
const RUNTIME_AWS_SIGNER = "aws://";

/**
 * Stand-in AWS keys for the agent on AgentCore Runtime. They let boto3 in the box sign a request,
 * which box then sends to the Box gateway signed again with RUNTIME_AWS_SIGNER, so they
 * authenticate nothing. box made these itself for the `aws://` secret.ref the Bedrock route had;
 * a backend-only route has no secret, so the profile names them.
 */
const RUNTIME_AWS_STAND_IN_LINES = [
  "# Stand-ins so boto3 in the box can build its requests. They authenticate nothing: every AWS",
  "# route goes to the Box gateway, and box signs each request for it with the execution role.",
  'AWS_ACCESS_KEY_ID = "box-stand-in"',
  'AWS_SECRET_ACCESS_KEY = "box-stand-in"',
].join("\n");

/**
 * The tools of box/base that get the project's write grant: box gives each one its own grant, so
 * each lists the agent's `deny_write` folders as well.
 */
const BOX_BASE_PROJECT_WRITE_TOOLS = ["uname"];

type Protocol = NonNullable<ScaffoldRuntimeInput["protocol"]>;

/**
 * The port callers use to reach the boxed agent, the one `agentcore dev` serves
 * the protocol on. The agent listens one port above it inside the box, because
 * macOS Box refuses an ingress port equal to the agent's own.
 */
export function boxIngressPort(protocol: Protocol | undefined): number {
  return DEV_PORTS[protocol ?? "HTTP"];
}

/** The port the boxed agent's server listens on inside the box, one above its ingress port. */
export function boxWorkloadPort(protocol: Protocol | undefined): number {
  return boxIngressPort(protocol) + 1;
}

/** The box folder at the project root that holds every agent's profiles. */
export const BOX_ROOT = ".box";

/** An agent's box folder, relative to the project root: `.box/<agentName>`. */
export function boxAgentDir(agentName: string): string {
  return posix.join(BOX_ROOT, agentName);
}

/**
 * An agent's local profile folder, relative to the project root:
 * `.box/<agentName>/local`. It holds the profile `agentcore dev` runs and the
 * policy files it names. box keeps the agent out of this folder, so the agent
 * cannot change its own profile.
 */
export function boxLocalDir(agentName: string): string {
  return posix.join(boxAgentDir(agentName), "local");
}

/**
 * An agent's AWS folder, relative to the project root: `.box/<agentName>/aws`.
 * Build and deploy generate the AgentCore Runtime profile and its resources
 * here, then copy the folder into the deploy artifact's `.box-dist/` staging.
 */
export function boxAwsDir(agentName: string): string {
  return posix.join(boxAgentDir(agentName), "aws");
}

/**
 * An agent's local box profile, relative to the project root: `box run
 * .box/<agentName>/local/profile.toml` there runs it.
 */
export function boxLocalProfileFile(agentName: string): string {
  return posix.join(boxLocalDir(agentName), "profile.toml");
}

/** An agent's local box profile at `projectRoot`. */
export function boxLocalProfilePath(projectRoot: string, agentName: string): string {
  return join(projectRoot, boxLocalProfileFile(agentName));
}

/**
 * Whether create writes a box profile for this runtime: a box template, CodeZip or container,
 * which runs its agent in Strands Box. Every other template runs its agent the usual way.
 */
export function hasBoxProfile(runtime: ScaffoldRuntimeInput): boolean {
  return startsInBoxOnCodeZip(runtime) || isBoxedContainer(runtime);
}

/** The Strands box container template, whose image starts `box run` in /app. */
export function isBoxedContainer(runtime: ScaffoldRuntimeInput): boolean {
  return (
    runtime.box === true &&
    runtime.build === "Container" &&
    runtime.language === "Python" &&
    runtime.framework === "strands"
  );
}

/** The frameworks whose Python CodeZip templates run their agent in a box on AgentCore Runtime. */
const CODEZIP_BOX_FRAMEWORKS: ReadonlySet<ScaffoldRuntimeInput["framework"]> = new Set([
  "strands",
  "langchain",
  "none",
]);

/**
 * Whether create writes the box start scripts, so a CodeZip deploy runs the agent in a box: a
 * Python CodeZip box template. start.sh serves the protocol's port, which the profile's ingress
 * names.
 */
export function startsInBoxOnCodeZip(runtime: ScaffoldRuntimeInput): boolean {
  return (
    runtime.box === true &&
    runtime.build === "CodeZip" &&
    runtime.language === "Python" &&
    CODEZIP_BOX_FRAMEWORKS.has(runtime.framework)
  );
}

/** Whether a runtime's entry point is the box start script that create writes. */
export function runsBoxStartScript(entrypoint: string): boolean {
  return entrypoint.split(":")[0] === BOX_CODEZIP_ENTRYPOINT;
}

/**
 * An `[egress.<name>]` route for a model provider that takes an API key.
 * `providerVariable` is the variable LiteLLM reads the provider's key from
 * when the project has no key of its own.
 */
type ApiKeyRoute = {
  name: string;
  host: string;
  header?: string;
  phantomPrefix?: string;
  providerVariable?: string;
};

const OPENAI: ApiKeyRoute = {
  name: "openai",
  host: "api.openai.com",
  providerVariable: "OPENAI_API_KEY",
};
const ANTHROPIC: ApiKeyRoute = {
  name: "anthropic",
  host: "api.anthropic.com",
  header: "x-api-key",
  phantomPrefix: "sk-ant-",
  providerVariable: "ANTHROPIC_API_KEY",
};
const GEMINI: ApiKeyRoute = {
  name: "gemini",
  host: "generativelanguage.googleapis.com",
  header: "x-goog-api-key",
  providerVariable: "GEMINI_API_KEY",
};

/**
 * The route the agent's model calls take when they carry an API key, or
 * `undefined` when the agent calls Bedrock, calls no model, or calls a host the
 * template does not name.
 */
function apiKeyRoute(runtime: ScaffoldRuntimeInput): ApiKeyRoute | undefined {
  switch (runtime.modelProvider) {
    case "OpenAI":
      return OPENAI;
    case "Anthropic":
      return ANTHROPIC;
    case "Gemini":
      return GEMINI;
    case "OpenAICompatible":
      // The schema requires --api-base for this provider; the type still allows it to be absent.
      return runtime.apiBase === undefined
        ? undefined
        : { name: "openai-compatible", host: new URL(runtime.apiBase).host };
    case "LiteLLM": {
      // LiteLLM picks the provider from the model ID's prefix.
      const prefix = (runtime.modelId ?? DEFAULT_MODEL_IDS.LiteLLM).split("/")[0];
      return { openai: OPENAI, anthropic: ANTHROPIC, gemini: GEMINI }[prefix ?? ""];
    }
    default:
      return undefined;
  }
}

/**
 * How the agent starts in the box, and the variable that sets the port it
 * listens on. `agentcore dev` reloads an HTTP agent on edits; AgentCore
 * Runtime does not.
 */
function serve(
  protocol: Protocol,
  appDir: string,
  workloadPort: number,
  reload: boolean,
  python = `${appDir}/.venv/bin/python`,
): { command: string[]; env: Record<string, string> } {
  if (protocol === "HTTP") {
    return {
      command: [
        python,
        "-m",
        "uvicorn",
        "main:app",
        "--app-dir",
        appDir,
        ...(reload ? ["--reload", "--reload-dir", appDir] : []),
        "--host",
        "127.0.0.1",
        "--port",
        String(workloadPort),
      ],
      env: { PORT: String(workloadPort) },
    };
  }
  // The box starts the agent in the project folder, and boxy refuses a script path inside it,
  // so the module is found through PYTHONPATH. `agentcore dev` runs these without a reload too.
  const portVariable = { AGUI: "PORT", A2A: "A2A_PORT", MCP: "FASTMCP_PORT" }[protocol];
  return {
    command: [python, "-m", "main"],
    env: { PYTHONPATH: appDir, [portVariable]: String(workloadPort) },
  };
}

/**
 * Where the agent's code and venv are, and what the box grants it. The venv
 * is inside the project, which the agent can write, and box refuses to run a
 * program from a folder the agent can write. `denyWrite` lists the venv, so
 * the agent can read and run it, compiled modules such as pydantic_core
 * included, but cannot change it.
 */
type Runner = {
  command: string[];
  env: Record<string, string>;
  read: string[];
  /** Comment lines above `exec`, each ending in a newline. */
  execComment?: string;
  exec: string[];
  denyWrite: string[];
};

/** A CodeZip agent: its code and venv are in the project's app/<runtime> folder. */
function codeZipRunner(protocol: Protocol, appDir: string, workloadPort: number): Runner {
  const { command, env } = serve(protocol, appDir, workloadPort, true);
  // Create runs `uv sync` with UV_MANAGED_PYTHON=1, so the venv links to a Python in this folder.
  // Optional, so a venv rebuilt on another Python still starts; that Python then needs its own grant.
  const uvPython = `{ path = ${str(UV_PYTHON_INSTALL_DIR)}, optional = true }`;
  return {
    command,
    env: { LOCAL_DEV: "1", ...env },
    read: [str(appDir), str(`${appDir}/.venv`), uvPython],
    exec: [optional(`${appDir}/.venv`), uvPython],
    denyWrite: [optional(`${appDir}/.venv`)],
  };
}

/**
 * The Strands container image's agent: the code and its venv are in /app,
 * where box starts, and the venv links to the image's own Python in
 * /usr/local. `agentcore dev` sets LOCAL_DEV and reloads it on edits.
 */
function containerRunner(workloadPort: number, dev: boolean): Runner {
  const appDir = "${{ workspace }}";
  const { command, env } = serve("HTTP", appDir, workloadPort, dev);
  return {
    command,
    env: { ...(dev && { LOCAL_DEV: "1" }), ...env },
    // The image's Python loads its own native modules (lib-dynload) from /usr/local/lib, and the
    // system libraries they link, such as libssl, from the multiarch folder.
    read: [str(appDir), str("/usr/local/lib"), str(LINUX_LIBRARIES)],
    exec: [
      optional(`${appDir}/.venv`),
      str("/usr/local/bin"),
      str("/usr/local/lib"),
      str(LINUX_LIBRARIES),
    ],
    denyWrite: [optional(`${appDir}/.venv`)],
  };
}

/**
 * A Python agent on a CodeZip deploy: the Runtime unpacks the zip into a
 * read-only folder and runs its own Python, at paths only the microVM knows.
 * The box/agentcore-codezip pack reads them from the environment start.py
 * exports (`${{ inputs.code.dir }}`, `${{ inputs.python.path }}`,
 * `${{ inputs.python.prefix }}`), and the box starts in a writable folder
 * outside the code, so nothing the agent runs needs `deny_write`.
 */
function runtimeCodeZipRunner(protocol: Protocol, workloadPort: number): Runner {
  const code = "${{ inputs.code.dir }}";
  const python = "${{ inputs.python.path }}";
  const pythonPrefix = "${{ inputs.python.prefix }}";
  const { command, env } = serve(protocol, code, workloadPort, false, python);
  return {
    command,
    env: {
      ...env,
      // Python finds the _ctypes that deploy stages before its own: its libffi uses static
      // trampolines, which Box Core's W^X filter allows.
      PYTHONPATH: `${code}/${BOX_CODEZIP_DIST}/ffi:${code}`,
    },
    // Managed Python can have /usr as its prefix. Grant its libraries and exact interpreter,
    // because Box rejects system roots and the agent does not need every executable below them.
    read: [
      str(code),
      str(python),
      optional(`${pythonPrefix}/lib`),
      optional(`${pythonPrefix}/lib64`),
      str("/usr/lib64"),
      str("/lib64"),
    ],
    execComment:
      "# Only the Python interpreter and deployed code are executable; libraries remain read only.\n",
    exec: [code, python].map(str),
    denyWrite: [],
  };
}

/** Which profile to render: the one `agentcore dev` runs, or the one AgentCore Runtime runs. */
export type BoxProfileTarget = "local" | "runtime";

/**
 * The box profile that runs the scaffolded agent, or `undefined` when the
 * template has none. It holds no host path: boxy fills `${{ workspace }}` (the
 * folder `box run` starts in) and `${{ home }}` at run time.
 *
 * - `local`: what `agentcore dev` runs. On a Mac, box starts in the project
 *   root and names no interpreter, only the folder of every uv-managed Python,
 *   so it is the same with and without `--skip-install`. The container
 *   template's runs in its dev image, in /app.
 * - `runtime`: what AgentCore Runtime runs, with no reload, signed with the
 *   execution role. Build and deploy render it from agentcore.json with
 *   {@link renderRuntimeBoxProfile}; `runtimeRoutes` holds the routes they
 *   derive from it, as sections that start with a blank line, and
 *   `runtimePolicies` the box profile's policy files, which staging copies
 *   beside it.
 */
export function renderBoxProfile(
  projectName: string,
  runtime: ScaffoldRuntimeInput,
  target: BoxProfileTarget = "local",
  runtimeRoutes = "",
  runtimePolicies: readonly string[] = [],
  region: string = BOX_GATEWAY_BEDROCK_REGION,
  runtimeMounts: readonly BoxRuntimeMount[] = [],
) {
  if (!hasBoxProfile(runtime)) return undefined;

  const protocol = runtime.protocol ?? "HTTP";
  const appDir = `\${{ workspace }}/app/${runtime.runtimeName}`;
  const deferred = target === "runtime" && runtimeMounts.length > 0;
  const ingressPort = deferred ? BOX_DEFERRED_INGRESS_PORT : boxIngressPort(protocol);
  const workloadPort = boxWorkloadPort(protocol);
  const onRuntime = target === "runtime";
  const container = isBoxedContainer(runtime);
  // The image's agent reads /app and writes nothing there. Build resolves the profile on the host,
  // where the image's /app/.venv does not exist, so a write grant would leave its Python unprotected
  // and box would refuse the profile. A CodeZip agent writes in the folder box starts in.
  const projectSection = container
    ? '# The agent, and the tools its packs add, can read the folder box starts in.\n[project]\naccess = "read"\n'
    : '# The agent, and the tools its packs add, can read and write the folder box starts in.\n[project]\naccess = "write"\n';
  const codeZipOnRuntime = onRuntime && !container;
  const runner = container
    ? containerRunner(workloadPort, !onRuntime)
    : onRuntime
      ? runtimeCodeZipRunner(protocol, workloadPort)
      : codeZipRunner(protocol, appDir, workloadPort);
  // In an image or the Runtime's microVM, the port is reached on the machine's own address.
  const listenHost = !deferred && (container || onRuntime) ? "0.0.0.0" : "127.0.0.1";
  const callsModel = protocol !== "MCP";
  const bedrock = callsModel && callsBedrockModel(runtime);
  // On the Runtime, each model route is a Box gateway target that build derives from the local
  // profile's [egress] sections, so only the local profile names the provider's host here.
  const keyed = callsModel && !onRuntime ? apiKeyRoute(runtime) : undefined;
  const environment = { ...runner.env, ...PYTHON_ENV };

  // The optional sections, each empty or ending in a newline.
  const header = codeZipOnRuntime
    ? "# Rendered by agentcore build and deploy from agentcore.json, for AgentCore Runtime. The box/agentcore and box/agentcore-codezip packs carry the deployed resources, the Runtime Python, and the code directory."
    : onRuntime
      ? "# Rendered by agentcore build and deploy from agentcore.json, for AgentCore Runtime. The box/agentcore pack carries the deployed resources' variables."
      : container
        ? "# Written by `agentcore create` for the agent's image, to run with `box run` in /app."
        : `# Written by \`agentcore create\`. Run \`box run ${boxLocalProfileFile(runtime.runtimeName)}\` in the project folder.`;
  const regionComment = onRuntime
    ? ""
    : "# The AWS region `agentcore create` resolved. Change it to call Bedrock in another region\n" +
      "# under `agentcore dev`; build and deploy set the region they deploy to.\n";
  const options = bedrock ? `[options]\n${regionComment}bedrock.region = ${str(region)}\n\n` : "";
  // Both Runtime profiles read the deployed resources' variables through the agentcore pack's inputs.
  const execComment = runner.execComment ?? "";
  const denyWrite =
    runner.denyWrite.length > 0 ? `deny_write = [${runner.denyWrite.join(", ")}]\n` : "";
  // box refuses to run a program from a folder that any process in the box can write, so each
  // tool that gets the project's write grant lists the venv too.
  const toolDenyWrite =
    !container && runner.denyWrite.length > 0
      ? BOX_BASE_PROJECT_WRITE_TOOLS.map(
          (tool) => `\n[tool.${tool}.filesystem]\ndeny_write = [${runner.denyWrite.join(", ")}]\n`,
        ).join("")
      : "";
  // Only the Runtime agent calls AgentCore: locally, LOCAL_DEV=1 skips Identity, and no memory ID
  // reaches the box, so Memory is off.
  const routes = onRuntime ? runtimeRoutes : "";
  const policies =
    onRuntime && runtimePolicies.length > 0
      ? `# The policy files of ${boxLocalProfileFile(runtime.runtimeName)}, copied unchanged beside this profile.\npolicies = ${list([...runtimePolicies])}\n`
      : "";
  const bedrockRoute = !bedrock
    ? ""
    : onRuntime
      ? // The Box gateway's `bedrock` target makes this route, with the rest of runtimeRoutes.
        ""
      : `
# Sign the model calls with your default AWS profile, as \`agentcore dev\` does without a box,
# rather than with the Bedrock API key that box/bedrock reads from AWS_BEARER_TOKEN_BEDROCK.
[egress.bedrock]
secret.ref = "aws://default"
`;
  const keyedRoute = keyed ? apiKeyRouteSection(keyed, apiKeyVariable(runtime, keyed)) : "";
  const packs = list([
    "box/base",
    ...(bedrock ? ["box/bedrock"] : []),
    // Both Runtime profiles read the deployed resources from the environment through this pack.
    ...(onRuntime ? [AGENTCORE_PACK_NAME] : []),
    // The CodeZip Runtime also reads its Python and code paths through this one.
    ...(codeZipOnRuntime ? [AGENTCORE_CODEZIP_PACK_NAME] : []),
  ]);
  const env = Object.entries(environment)
    .map(([name, value]) => `${name} = ${str(value)}`)
    .join("\n");
  // On the Runtime every AWS route is a Box gateway backend, and box adds no stand-in AWS keys for
  // a backend-only route, so boto3 in the box would find none and refuse to build a request.
  const awsStandIns = onRuntime ? `\n${RUNTIME_AWS_STAND_IN_LINES}` : "";

  return `# Runs the agent of the AgentCore project '${projectName}' in a box.
${header}
packs = ${packs}
${policies}
[profile]
name = ${str(projectName)}

${projectSection}
${options}[agent]
command = ${list(runner.command)}

[agent.env]
${env}${awsStandIns}

[agent.filesystem]
read = [${[...runner.read, ...runtimeMounts.map(({ path }) => str(path))].join(", ")}]
${execComment}exec = [${runner.exec.join(", ")}]
${denyWrite}
[[agent.ingress]]
listen = ${str(`${listenHost}:${ingressPort}`)}
workload_port = ${workloadPort}
${toolDenyWrite}${routes}${bedrockRoute}${keyedRoute}`;
}

/**
 * A route the agent's calls take on the Runtime: the box re-routes calls to
 * `host` to the runtime's Box gateway target of the same name, signing them for
 * the gateway with the execution role; the gateway signs the call to `host`
 * with its own role. Every `[egress.<name>]` on the Runtime is one of these, so
 * every outbound call goes through the Box gateway. Starts with a blank line.
 */
function runtimeGatewayRouteSection(target: string, host: string, region: string): string {
  const key = tomlKey(target);
  return `
# Calls to ${host}, through the runtime's Box gateway's '${target}' target.
[egress.${key}]
destinations = [${str(host)}]
${runtimeGatewayBackend(`egress.${key}`, target, region)}`;
}

/** An HTTP MCP server of the box profile that a Box gateway target serves. */
type RuntimeMcpServer = { readonly name: string; readonly secret?: McpSource["secret"] };
type McpSource = Extract<BoxNetworkSource, { kind: "mcp" }>;

/**
 * An HTTP MCP server on the Runtime: the box re-routes the server's calls to
 * `host` to the runtime's Box gateway target, as {@link runtimeGatewayRouteSection}
 * does, and still decides each `mcp:call`, as the server keeps its name. An
 * `env://` secret stays, so the agent keeps its stand-in and box removes it; the
 * gateway sends the key. Box refuses a signed secret beside a backend, and
 * `inject` has no effect there, so neither stays. Starts with a blank line.
 */
function runtimeMcpServerSection(
  server: RuntimeMcpServer,
  target: string,
  host: string,
  region: string,
): string {
  const key = tomlKey(server.name);
  const secret = server.secret?.ref.startsWith("env://")
    ? Object.entries(server.secret)
        .filter(([field, value]) => field !== "inject" && value !== undefined)
        .map(([field, value]) => `secret.${tomlKey(field)} = ${str(value as string)}\n`)
        .join("")
    : "";
  return `
# The MCP server '${server.name}' at ${host}, through the runtime's Box gateway's '${target}' target.
[mcp.${key}]
type = "http"
destinations = [${str(host)}]
${secret}${runtimeGatewayBackend(`mcp.${key}`, target, region)}`;
}

/**
 * The backend of a Runtime route or MCP server: the runtime's Box gateway
 * target. Both Runtime profiles read the gateway URL from the environment
 * through the agentcore pack's input, and sign with the execution role through
 * a bare `aws://`. Starts with a blank line.
 */
function runtimeGatewayBackend(table: string, target: string, region: string): string {
  return `
[[${table}.backends]]
url = ${str(`\${{ inputs.gateway.url }}/${target}`)}
auth.ref = ${str(RUNTIME_AWS_SIGNER)}
auth.aws.service = "bedrock-agentcore"
auth.aws.region = ${str(region)}
`;
}

/**
 * The Runtime routes of a runtime: one for each passthrough target of its Box
 * gateway, `<runtime>-box`, sent to that target, so a target in agentcore.json
 * is what gives the boxed agent a route. A target that serves an HTTP MCP
 * server of `servers` is that `[mcp.<server>]`, and every other target is an
 * `[egress.<target>]`. Build adds the targets the template's calls need (see
 * `addBoxGatewayTargets`) before it renders. None outside a Box project, which
 * has no Box gateway.
 */
function runtimeGatewayRoutes(
  spec: ProjectSpec,
  runtime: ProjectRuntime,
  region: string,
  servers: ReadonlyMap<string, RuntimeMcpServer>,
): string {
  if (!isBoxProject(spec)) return "";
  const gateway = spec.agentCoreGateways.find(({ name }) => name === boxGatewayName(runtime.name));
  return (gateway?.targets ?? [])
    .flatMap((target) => {
      if (target.targetType !== "passthrough" || !target.passthrough) return [];
      const host = new URL(target.passthrough.endpoint).host;
      const server = servers.get(target.name);
      return [
        server
          ? runtimeMcpServerSection(server, target.name, host, region)
          : runtimeGatewayRouteSection(target.name, host, region),
      ];
    })
    .join("");
}

/** The HTTP MCP server each Box gateway target of `hosts` serves, by the target's name. */
function runtimeMcpServers(hosts: BoxNetwork["hosts"]): Map<string, RuntimeMcpServer> {
  const servers = new Map<string, RuntimeMcpServer>();
  for (const host of hosts) {
    const source = host.sources.find((s): s is McpSource => s.kind === "mcp");
    if (source === undefined || host.target === undefined) continue;
    servers.set(host.target, {
      name: source.mcpEntry,
      ...(source.secret && { secret: source.secret }),
    });
  }
  return servers;
}

/**
 * A CloudWatch target of the box profile `profileFile` on the Runtime: its
 * `[telemetry.<name>]` table with the same keys, signed with the execution role
 * through a bare `aws://`, whatever the box profile signs it with. Starts with a
 * blank line.
 */
function runtimeTelemetrySection(target: CloudWatchTelemetry, profileFile: string): string {
  const logs =
    target.kind === "cloudwatch_logs"
      ? `log_group = ${str(target.logGroup)}\nlog_stream = ${str(target.logStream)}\n`
      : "";
  const include = target.include ? `include = ${list([...target.include])}\n` : "";
  const key = tomlKey(target.name);
  return `
# The [telemetry.${key}] target of ${profileFile}, signed with the execution role.
[telemetry.${key}]
kind = ${str(target.kind)}
region = ${str(target.region)}
${logs}${include}secret.ref = ${str(RUNTIME_AWS_SIGNER)}
`;
}

/**
 * The AgentCore Runtime box profile of a runtime that runs its agent in a box,
 * derived from agentcore.json: the runtime's build, protocol, and model
 * provider, and a route for each passthrough target of its Box gateway; and,
 * from the runtime's Box network model, the box profile's policy files under
 * `policies`, the HTTP MCP server that a target serves, and each CloudWatch
 * `[telemetry]` target. agentcore.json does not record the framework, and the profile
 * does not depend on it beyond the container case, so the input names Strands,
 * one of the frameworks that run in a box.
 */
export function renderRuntimeBoxProfile(
  spec: ProjectSpec,
  runtime: ProjectRuntime,
  network?: Pick<BoxNetwork, "policyFiles"> &
    Partial<Pick<BoxNetwork, "region" | "hosts" | "telemetry">>,
): string {
  const input = {
    runtimeName: runtime.name,
    build: runtime.build,
    language: "Python",
    framework: "strands",
    protocol: runtime.protocol,
    modelProvider: runtime.modelProvider,
    modelId: runtime.modelId,
    // Build and deploy render this only for a runtime that runs its agent in a box.
    box: true,
  } as ScaffoldRuntimeInput;
  const region = network?.region ?? BOX_GATEWAY_BEDROCK_REGION;
  const profile = renderBoxProfile(
    spec.name,
    input,
    "runtime",
    runtimeGatewayRoutes(spec, runtime, region, runtimeMcpServers(network?.hosts ?? [])),
    network?.policyFiles,
    network?.region,
    boxRuntimeMounts(runtime),
  )!;
  const profileFile = boxLocalProfileFile(runtime.name);
  return (
    profile +
    (network?.telemetry ?? [])
      .map((target) => runtimeTelemetrySection(target, profileFile))
      .join("")
  );
}

/**
 * The variable the box reads the model provider's API key from: the project's
 * credential, as the template's model code reads it, or, for a LiteLLM agent
 * created with no key, the provider's own variable, which LiteLLM reads too.
 */
function apiKeyVariable(runtime: ScaffoldRuntimeInput, route: ApiKeyRoute): string {
  if (runtime.apiKey === undefined && route.providerVariable !== undefined) {
    return route.providerVariable;
  }
  return credentialEnvVarName(
    modelProviderCredentialName(runtime.runtimeName, runtime.modelProvider),
  );
}

/**
 * What `agentcore create` tells the user about the box profile of `runtime`
 * when the profile cannot carry the agent's model calls by itself: a LiteLLM
 * agent created with no API key, whose key the box reads from a variable that
 * nothing has set yet, or a LiteLLM agent on a provider the profile has no
 * route for.
 */
export function boxProfileWarnings(runtime: ScaffoldRuntimeInput): string[] {
  if (!hasBoxProfile(runtime) || runtime.protocol === "MCP") return [];
  if (runtime.modelProvider !== "LiteLLM" || callsBedrockModel(runtime)) return [];
  const route = apiKeyRoute(runtime);
  if (route === undefined) {
    const modelId = runtime.modelId ?? DEFAULT_MODEL_IDS.LiteLLM;
    const prefix = modelId.split("/")[0];
    return [
      `the box profile has no route for the LiteLLM model '${modelId}': add an ` +
        `[egress.${prefix}] section with its provider's host to ${boxLocalProfileFile(runtime.runtimeName)}, or the box ` +
        "blocks the agent's model calls",
    ];
  }
  if (runtime.apiKey !== undefined || route.providerVariable === undefined) return [];
  return [
    `the box profile reads the ${route.name} API key from ${route.providerVariable}: set it in ` +
      "agentcore/.env.local or your shell before `agentcore dev`, or the agent's model calls " +
      "go out with no key",
  ];
}

/**
 * The `box/agentcore` pack a container runtime imports: it declares the inputs the runtime profile
 * reads from the environment the Runtime sets after deploy. The `gateway.url` input fills each
 * egress backend `url`, bounded by a pattern so a value from the environment names only the host the
 * profile expects. One input per project memory carries its ID into the agent's environment. box
 * finds the pack beside its binary at {@link AGENTCORE_PACK_PATH}; build and deploy stage it there.
 */
export function renderAgentCorePack(spec: ProjectSpec): string {
  const memories = spec.memories ?? [];
  const memoryInputs = memories
    .map(
      (memory) => `
[inputs.memory.${tomlKey(memory.name)}.id]
description = ${str(`The deployed '${memory.name}' Memory ID.`)}
from = ${str(`env:${memoryEnvVarName(memory.name)}`)}`,
    )
    .join("");
  const memoryEnv = memories
    .map(
      (memory) =>
        `${memoryEnvVarName(memory.name)} = ${str(`\${{ inputs.memory.${tomlKey(memory.name)}.id }}`)}`,
    )
    .join("\n");
  const agentEnv = memoryEnv ? `\n[agent.env]\n${memoryEnv}\n` : "";
  return `# The deployed AgentCore resources of '${spec.name}', read from the environment the Runtime sets.
# Written by agentcore build and deploy. The runtime profile imports it as ${AGENTCORE_PACK_NAME}.
[pack]
name = ${str(AGENTCORE_PACK_NAME)}
version = 1
kind = "support"

# The Box gateway's URL exists only after deploy; the CDK sets it on the Runtime.
[inputs.gateway.url]
description = "The runtime's Box gateway URL."
from = ${str(`env:${BOX_GATEWAY_URL_ENV}`)}
pattern = ${str(GATEWAY_URL_PATTERN)}${memoryInputs}
${agentEnv}`;
}

/**
 * The `box/agentcore-codezip` pack a CodeZip Runtime profile adds: the Runtime's Python interpreter
 * and base prefix, and the read-only code directory, which only the microVM knows. start.py exports
 * them ({@link BOX_PYTHON_ENV}, {@link BOX_PYTHON_PREFIX_ENV}, {@link BOX_CODE_ENV}) before it runs
 * box, and the profile reads them through these inputs, so no start script fills the profile in. box
 * finds the pack beside its binary at {@link AGENTCORE_CODEZIP_PACK_PATH}.
 */
export function renderAgentCoreCodeZipPack(): string {
  return `# The CodeZip Runtime's Python and code directory, read from the environment start.py exports.
# Written by agentcore build and deploy. The runtime profile imports it as ${AGENTCORE_CODEZIP_PACK_NAME}.
[pack]
name = ${str(AGENTCORE_CODEZIP_PACK_NAME)}
version = 1
kind = "support"

# The interpreter and code path exist only in the microVM; start.py exports them before box runs.
[inputs.python.path]
description = "The AgentCore Runtime's Python interpreter."
from = ${str(`env:${BOX_PYTHON_ENV}`)}
pattern = ${str(ABSOLUTE_PATH_PATTERN)}

[inputs.python.prefix]
description = "The Python interpreter's base prefix, for its standard library."
from = ${str(`env:${BOX_PYTHON_PREFIX_ENV}`)}

[inputs.code.dir]
description = "The unpacked zip directory the Runtime runs the agent from."
from = ${str(`env:${BOX_CODE_ENV}`)}
pattern = ${str(ABSOLUTE_PATH_PATTERN)}
`;
}

/** The `[egress.<name>]` section for a model provider's API key, starting with a blank line. */
function apiKeyRouteSection(route: ApiKeyRoute, variable: string): string {
  const header = route.header ? `secret.header = ${str(route.header)}\n` : "";
  const phantomPrefix = route.phantomPrefix
    ? `secret.phantom_prefix = ${str(route.phantomPrefix)}\n`
    : "";
  return `
# The box adds your API key to each model call. It reads the key from ${variable} in the
# environment of \`box run\`; the agent gets a stand-in value under that same name.
[egress.${route.name}]
destinations = [${str(route.host)}]
secret.ref = ${str(`env://${variable}`)}
${header}${phantomPrefix}`;
}

/** A TOML basic string. JSON's escapes are valid TOML escapes. */
function str(value: string): string {
  return JSON.stringify(value);
}

/** A filesystem entry the box skips when the path does not exist, such as a venv not yet installed. */
function optional(path: string): string {
  return `{ path = ${str(path)}, optional = true }`;
}

function list(values: string[]): string {
  return `[${values.map(str).join(", ")}]`;
}

/** A TOML key: bare when TOML allows it, else a quoted string. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : str(key);
}
