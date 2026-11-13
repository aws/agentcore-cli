import { join } from "node:path";
import {
  BOX_GATEWAY_AGENTCORE_HOST,
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  BOX_GATEWAY_BEDROCK_REGION,
  BOX_GATEWAY_NAME,
  callsBedrockModel,
} from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { defaultMemoryName } from "../../../projectSchemas/memory";
import type { ProjectSpec } from "../../../projectSchemas/project";
import { DEFAULT_MODEL_IDS, type ProjectRuntime } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";

/** Where uv installs the Pythons it manages, as a boxy path. */
const UV_PYTHON_INSTALL_DIR = "${{ home }}/.local/share/uv/python";

/** The system libraries of the Linux arm64 image, such as libssl. */
const LINUX_LIBRARIES = "/usr/lib/aarch64-linux-gnu";

/**
 * The entry point of a runtime that runs its agent in a box on a CodeZip
 * deploy: start.py runs start.sh, which starts `box run`. Create writes both.
 */
export const BOX_CODEZIP_ENTRYPOINT = "start.py";

/** The folder deploy stages box into, inside the runtime's code folder, so it ships in the zip. */
export const BOX_CODEZIP_DIST = ".box-dist";

/** Placeholders in the CodeZip Runtime profile, which start.sh fills in at start. */
const CODEZIP_CODE = "@CODE@";
const CODEZIP_PYTHON = "@PYTHON@";
const CODEZIP_PYTHON_PREFIX = "@PYTHON_PREFIX@";

/**
 * The line in a Runtime profile's `[agent.env]` that start.sh replaces with
 * the deployed resources' variables.
 */
const AGENT_ENV_MARKER = "# @AGENT_ENV@";

/**
 * The placeholder for the Box gateway's URL, which exists only once the
 * gateway is deployed; start.sh fills it in from AGENTCORE_GATEWAY_BOX_URL.
 */
export const BOX_GATEWAY_URL_PLACEHOLDER = "@GATEWAY_BOX_URL@";

/**
 * The credential Box signs with on AgentCore Runtime: a bare `aws://` resolves the
 * AWS default credential chain, which finds the execution role and refreshes it.
 */
const RUNTIME_AWS_SIGNER = "aws://";

type Protocol = NonNullable<ScaffoldRuntimeInput["protocol"]>;

/**
 * The port callers use to reach the boxed agent, the one `agentcore dev` serves
 * the protocol on. The agent listens one port above it inside the box, because
 * macOS Box refuses an ingress port equal to the agent's own.
 */
export function boxIngressPort(protocol: Protocol | undefined): number {
  return DEV_PORTS[protocol ?? "HTTP"];
}

/**
 * The project's boxy profile, relative to the project root: `box run
 * .box/profile.toml` there runs it. box keeps the agent out of the project's
 * `.box` folder, so the agent cannot change its own profile.
 */
export const BOX_PROFILE_FILE = ".box/profile.toml";

/** The boxy profile of the project at `projectRoot`. */
export function boxProfilePath(projectRoot: string): string {
  return join(projectRoot, ".box", "profile.toml");
}

/**
 * Whether create writes a boxy profile for this runtime: every Python CodeZip
 * template, and the Strands container template, whose image runs the agent
 * with `box run`. The Bedrock Managed Agents image has no box.
 */
export function hasBoxProfile(runtime: ScaffoldRuntimeInput): boolean {
  return (
    (runtime.language === "Python" && runtime.build === "CodeZip") || isBoxedContainer(runtime)
  );
}

/** The Strands container template, whose image starts `box run` in /app. */
export function isBoxedContainer(runtime: ScaffoldRuntimeInput): boolean {
  return (
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
 * Whether create writes the box start scripts, so a CodeZip deploy runs the
 * agent in a box: every Python CodeZip template (Strands over HTTP, A2A and
 * AG-UI, LangChain, minimal, and the FastMCP server). start.sh serves the
 * protocol's port, which the profile's ingress names.
 */
export function startsInBoxOnCodeZip(runtime: ScaffoldRuntimeInput): boolean {
  return (
    runtime.build === "CodeZip" &&
    runtime.language === "Python" &&
    CODEZIP_BOX_FRAMEWORKS.has(runtime.framework)
  );
}

/** Whether a runtime's entry point is the box start script that create writes. */
export function runsBoxStartScript(entrypoint: string): boolean {
  return entrypoint.split(":")[0] === BOX_CODEZIP_ENTRYPOINT;
}

/** An `[egress.<name>]` route for a model provider that takes an API key. */
type ApiKeyRoute = { name: string; host: string; header?: string; phantomPrefix?: string };

const OPENAI: ApiKeyRoute = {
  name: "openai",
  host: "api.openai.com",
};
const ANTHROPIC: ApiKeyRoute = {
  name: "anthropic",
  host: "api.anthropic.com",
  header: "x-api-key",
  phantomPrefix: "sk-ant-",
};
const GEMINI: ApiKeyRoute = {
  name: "gemini",
  host: "generativelanguage.googleapis.com",
  header: "x-goog-api-key",
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
      return runtime.apiBase === undefined
        ? OPENAI
        : { name: "openai-compatible", host: new URL(runtime.apiBase).hostname };
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
  // Optional, so a venv built on another Python still starts; that Python then needs its own grant.
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
 * read-only folder and runs its own Python, at paths only start.sh can see.
 * start.sh fills the placeholders in, and the box starts in a writable folder
 * outside the code, so nothing the agent runs needs `deny_write`.
 */
function runtimeCodeZipRunner(protocol: Protocol, workloadPort: number): Runner {
  const { command, env } = serve(protocol, CODEZIP_CODE, workloadPort, false, CODEZIP_PYTHON);
  return {
    command,
    env: {
      ...env,
      // Python finds the _ctypes that deploy stages before its own: its libffi uses static
      // trampolines, which Box Core's W^X filter allows.
      PYTHONPATH: `${CODEZIP_CODE}/${BOX_CODEZIP_DIST}/ffi:${CODEZIP_CODE}`,
    },
    read: [CODEZIP_CODE, CODEZIP_PYTHON_PREFIX, "/usr/lib64", "/lib64"].map(str),
    execComment:
      "# Box Core adds the loader folders itself and refuses exec on them, so they are read only.\n" +
      "# One grant may not sit inside another, so the Python prefix covers its bin/ folder.\n",
    exec: [CODEZIP_CODE, CODEZIP_PYTHON_PREFIX].map(str),
    denyWrite: [],
  };
}

/** Which profile to render: the one `agentcore dev` runs, or the one AgentCore Runtime runs. */
export type BoxProfileTarget = "local" | "runtime";

/**
 * The boxy profile that runs the scaffolded agent, or `undefined` when the
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
 *   derive from it, as sections that start with a blank line.
 */
export function renderBoxProfile(
  projectName: string,
  runtime: ScaffoldRuntimeInput,
  target: BoxProfileTarget = "local",
  runtimeRoutes = "",
) {
  if (!hasBoxProfile(runtime)) return undefined;

  const region = BOX_GATEWAY_BEDROCK_REGION;
  const protocol = runtime.protocol ?? "HTTP";
  const appDir = `\${{ workspace }}/app/${runtime.runtimeName}`;
  const ingressPort = boxIngressPort(protocol);
  const workloadPort = ingressPort + 1;
  const onRuntime = target === "runtime";
  const container = isBoxedContainer(runtime);
  const codeZipOnRuntime = onRuntime && !container;
  const runner = container
    ? containerRunner(workloadPort, !onRuntime)
    : onRuntime
      ? runtimeCodeZipRunner(protocol, workloadPort)
      : codeZipRunner(protocol, appDir, workloadPort);
  // In an image or the Runtime's microVM, the port is reached on the machine's own address.
  const listenHost = container || onRuntime ? "0.0.0.0" : "127.0.0.1";
  const callsModel = protocol !== "MCP";
  const bedrock = callsModel && callsBedrockModel(runtime);
  const keyed = callsModel ? apiKeyRoute(runtime) : undefined;
  const environment = { ...runner.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" };

  // The optional sections, each empty or ending in a newline.
  const header = codeZipOnRuntime
    ? "# Rendered by agentcore build and deploy from agentcore.json, for AgentCore Runtime. start.sh fills in @CODE@, @PYTHON@, @PYTHON_PREFIX@ and the deployed resources' variables."
    : onRuntime
      ? "# Rendered by agentcore build and deploy from agentcore.json, for AgentCore Runtime. start.sh adds the deployed resources' variables."
      : container
        ? "# Written by `agentcore create` for the agent's image, to run with `box run` in /app."
        : `# Written by \`agentcore create\`. Run \`box run ${BOX_PROFILE_FILE}\` in the project folder.`;
  const options = bedrock ? `[options]\nbedrock.region = ${str(region)}\n\n` : "";
  const envMarker = onRuntime ? `${AGENT_ENV_MARKER}\n` : "";
  const execComment = runner.execComment ?? "";
  const denyWrite =
    runner.denyWrite.length > 0 ? `deny_write = [${runner.denyWrite.join(", ")}]\n` : "";
  // Only the Runtime agent calls AgentCore: locally, LOCAL_DEV=1 skips Identity, and no memory ID
  // reaches the box, so Memory is off.
  const routes = onRuntime ? runtimeRoutes : "";
  const bedrockRoute = !bedrock
    ? ""
    : onRuntime
      ? `
# Sign the model calls with the Runtime's execution role.
[egress.bedrock]
secret.ref = ${str(RUNTIME_AWS_SIGNER)}
`
      : `
# Sign the model calls with your default AWS profile, as \`agentcore dev\` does without a box,
# rather than with the Bedrock API key that box/bedrock reads from AWS_BEARER_TOKEN_BEDROCK.
[egress.bedrock]
secret.ref = "aws://default"
`;
  const keyedRoute = !keyed
    ? ""
    : onRuntime
      ? `
# Open: on AgentCore Runtime the agent reads its ${runtime.modelProvider} API key from
# AgentCore Identity, so ${keyed.host} has no route here yet.
`
      : apiKeyRouteSection(keyed, apiKeyVariable(runtime));
  const packs = list(["box/base", ...(bedrock ? ["box/bedrock"] : [])]);
  const env = Object.entries(environment)
    .map(([name, value]) => `${name} = ${str(value)}`)
    .join("\n");

  return `# Runs the agent of the AgentCore project '${projectName}' in a box.
${header}
packs = ${packs}

[profile]
name = ${str(projectName)}

${options}[agent]
command = ${list(runner.command)}

[agent.env]
${env}
${envMarker}
[agent.filesystem]
read = [${runner.read.join(", ")}]
${execComment}exec = [${runner.exec.join(", ")}]
${denyWrite}
[[agent.ingress]]
listen = ${str(`${listenHost}:${ingressPort}`)}
workload_port = ${workloadPort}
${routes}${bedrockRoute}${keyedRoute}`;
}

/**
 * The route the agent's AgentCore Memory calls take on the Runtime: the box
 * sends them to the Box gateway's AgentCore passthrough target, signed with
 * the execution role. Starts with a blank line.
 */
function runtimeMemoryRouteSection(): string {
  const target = BOX_GATEWAY_AGENTCORE_TARGET_NAME;
  return `
# AgentCore Memory, through the '${BOX_GATEWAY_NAME}' gateway's '${target}' target.
[egress.${target}]
destinations = [${str(BOX_GATEWAY_AGENTCORE_HOST)}]

[[egress.${target}.backends]]
url = ${str(`${BOX_GATEWAY_URL_PLACEHOLDER}/${target}`)}
auth.ref = ${str(RUNTIME_AWS_SIGNER)}
auth.aws.service = "bedrock-agentcore"
auth.aws.region = ${str(BOX_GATEWAY_BEDROCK_REGION)}
`;
}

/**
 * The AgentCore Runtime box profile of a runtime that runs its agent in a box,
 * derived from agentcore.json: the runtime's build, protocol, and model
 * provider, and, when the project has the runtime's default Memory, the route
 * its Memory calls take through the Box gateway. agentcore.json does not
 * record the framework, and the profile does not depend on it beyond the
 * container case, so the input names Strands, one of the frameworks that run
 * in a box.
 */
export function renderRuntimeBoxProfile(spec: ProjectSpec, runtime: ProjectRuntime): string {
  const memory = spec.memories.some((entry) => entry.name === defaultMemoryName(runtime.name));
  const input = {
    runtimeName: runtime.name,
    build: runtime.build,
    language: "Python",
    framework: "strands",
    protocol: runtime.protocol,
    modelProvider: runtime.modelProvider,
    modelId: runtime.modelId,
  } as ScaffoldRuntimeInput;
  return renderBoxProfile(spec.name, input, "runtime", memory ? runtimeMemoryRouteSection() : "")!;
}

/** The variable that holds the model provider's API key, as the template's model code reads it. */
function apiKeyVariable(runtime: ScaffoldRuntimeInput): string {
  return credentialEnvVarName(`${runtime.runtimeName}${runtime.modelProvider}ApiKey`);
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
