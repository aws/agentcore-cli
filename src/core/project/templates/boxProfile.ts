import { join } from "node:path";
import {
  DEFAULT_EGRESS_BEDROCK_REGION,
  callsBedrockModel,
} from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { DEFAULT_MODEL_IDS } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";

/** Where uv installs the Pythons it manages, as a boxy path. */
const UV_PYTHON_INSTALL_DIR = "${{ home }}/.local/share/uv/python";

/** The system libraries of the Linux arm64 image, such as libssl. */
const LINUX_LIBRARIES = "/usr/lib/aarch64-linux-gnu";

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
function isBoxedContainer(runtime: ScaffoldRuntimeInput): boolean {
  return (
    runtime.build === "Container" &&
    runtime.language === "Python" &&
    runtime.framework === "strands"
  );
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

/** How the agent starts in the box, and the variable that sets the port it listens on. */
function serve(
  protocol: Protocol,
  appDir: string,
  workloadPort: number,
): { command: string[]; env: Record<string, string> } {
  const python = `${appDir}/.venv/bin/python`;
  if (protocol === "HTTP") {
    return {
      command: [
        python,
        "-m",
        "uvicorn",
        "main:app",
        "--app-dir",
        appDir,
        "--reload",
        "--reload-dir",
        appDir,
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
  exec: string[];
  denyWrite: string[];
};

/** A CodeZip agent: its code and venv are in the project's app/<runtime> folder. */
function codeZipRunner(protocol: Protocol, appDir: string, workloadPort: number): Runner {
  const { command, env } = serve(protocol, appDir, workloadPort);
  // Optional, so a venv built on another Python still starts; that Python then needs its own grant.
  const uvPython = `{ path = ${str(UV_PYTHON_INSTALL_DIR)}, optional = true }`;
  return {
    command,
    env,
    read: [str(appDir), str(`${appDir}/.venv`), uvPython],
    exec: [optional(`${appDir}/.venv`), uvPython],
    denyWrite: [optional(`${appDir}/.venv`)],
  };
}

/**
 * The Strands container image's agent: the code and its venv are in /app,
 * where box starts, and the venv links to the image's own Python in
 * /usr/local.
 */
function containerRunner(workloadPort: number): Runner {
  const appDir = "${{ workspace }}";
  const { command, env } = serve("HTTP", appDir, workloadPort);
  return {
    command,
    env,
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
 * The boxy profile that runs the scaffolded agent, or `undefined` when the
 * template has none. It holds no host path: boxy fills `${{ workspace }}` (the
 * folder `box run` starts in, the project root) and `${{ home }}` at run time.
 * It names no interpreter either, only the folder of every uv-managed Python,
 * so it is the same with and without `--skip-install`.
 */
export function renderBoxProfile(projectName: string, runtime: ScaffoldRuntimeInput) {
  if (!hasBoxProfile(runtime)) return undefined;

  const region = DEFAULT_EGRESS_BEDROCK_REGION;
  const protocol = runtime.protocol ?? "HTTP";
  const appDir = `\${{ workspace }}/app/${runtime.runtimeName}`;
  const ingressPort = boxIngressPort(protocol);
  const workloadPort = ingressPort + 1;
  const container = isBoxedContainer(runtime);
  const runner = container
    ? containerRunner(workloadPort)
    : codeZipRunner(protocol, appDir, workloadPort);
  // In the image, Docker forwards the host's port to the container's own address, not loopback.
  const listenHost = container ? "0.0.0.0" : "127.0.0.1";
  const callsModel = protocol !== "MCP";
  const bedrock = callsModel && callsBedrockModel(runtime);
  const keyed = callsModel ? apiKeyRoute(runtime) : undefined;
  const environment = {
    LOCAL_DEV: "1",
    ...runner.env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
  };

  // The optional sections, each empty or ending in a newline.
  const header = container
    ? "# Written by `agentcore create` for the agent's image, to run with `box run` in /app."
    : `# Written by \`agentcore create\`. Run \`box run ${BOX_PROFILE_FILE}\` in the project folder.`;
  const options = bedrock ? `[options]\nbedrock.region = ${str(region)}\n\n` : "";
  const bedrockRoute = bedrock
    ? `
# Sign the model calls with your default AWS profile, as \`agentcore dev\` does without a box,
# rather than with the Bedrock API key that box/bedrock reads from AWS_BEARER_TOKEN_BEDROCK.
[egress.bedrock]
secret.ref = "aws://default"
`
    : "";
  const keyedRoute = keyed ? apiKeyRouteSection(keyed, apiKeyVariable(runtime)) : "";
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

[agent.filesystem]
read = [${runner.read.join(", ")}]
exec = [${runner.exec.join(", ")}]
deny_write = [${runner.denyWrite.join(", ")}]

[[agent.ingress]]
listen = ${str(`${listenHost}:${ingressPort}`)}
workload_port = ${workloadPort}
${bedrockRoute}${keyedRoute}`;
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
