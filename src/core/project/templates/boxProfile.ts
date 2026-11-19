import { join } from "node:path";
import {
  DEFAULT_EGRESS_BEDROCK_REGION,
  callsBedrockModel,
} from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { DEFAULT_MODEL_IDS } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";
import { PYTHON_ENV } from "../../dev/codezip";
import { modelProviderCredentialName } from "./runtime";

/** Where a box template's venv gets its uv-managed Python, relative to the home folder. */
const UV_PYTHON_HOME_DIR = ".local/share/uv/python";

/** That folder as a boxy path. */
const UV_PYTHON_INSTALL_DIR = "${{ home }}/" + UV_PYTHON_HOME_DIR;

/**
 * The environment `uv sync` builds a box template's venv with: a uv-managed Python, installed in
 * the folder the profile grants, so a user's UV_PYTHON_INSTALL_DIR or XDG_DATA_HOME cannot move
 * it out of the grant.
 */
export function boxUvSyncEnv(home: string): Record<string, string> {
  return { UV_MANAGED_PYTHON: "1", UV_PYTHON_INSTALL_DIR: join(home, UV_PYTHON_HOME_DIR) };
}

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
 * The project's box profile, relative to the project root: `box run
 * .box/profile.toml` there runs it. box keeps the agent out of the project's
 * `.box` folder, so the agent cannot change its own profile.
 */
export const BOX_PROFILE_FILE = ".box/profile.toml";

/** The box profile of the project at `projectRoot`. */
export function boxProfilePath(projectRoot: string): string {
  return join(projectRoot, BOX_PROFILE_FILE);
}

/**
 * Whether create writes a box profile for this runtime: every Python CodeZip
 * template. A container template gets none until its image runs `box run`,
 * and the Bedrock Managed Agents image has no box.
 */
export function hasBoxProfile(runtime: ScaffoldRuntimeInput): boolean {
  return runtime.language === "Python" && runtime.build === "CodeZip";
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
  // serve_a2a puts its listen port in the agent card's URL, but callers reach the agent only
  // through box's ingress port, so the card names that port instead.
  const cardUrl: Record<string, string> =
    protocol === "A2A"
      ? { AGENTCORE_RUNTIME_URL: `http://localhost:${boxIngressPort(protocol)}/` }
      : {};
  return {
    command: [python, "-m", "main"],
    env: { PYTHONPATH: appDir, [portVariable]: String(workloadPort), ...cardUrl },
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
  // Create runs `uv sync` with boxUvSyncEnv, so the venv links to a Python in this folder.
  // Optional, so a venv rebuilt on another Python still starts; that Python then needs its own grant.
  const uvPython = `{ path = ${str(UV_PYTHON_INSTALL_DIR)}, optional = true }`;
  return {
    command,
    env,
    read: [str(appDir), optional(`${appDir}/.venv`), uvPython],
    exec: [optional(`${appDir}/.venv`), uvPython],
    denyWrite: [optional(`${appDir}/.venv`)],
  };
}

/**
 * The box profile that runs the scaffolded agent, or `undefined` when the
 * template has none. It holds no host path: boxy fills `${{ workspace }}` (the
 * folder `box run` starts in, the project root) and `${{ home }}` at run time.
 * It names no interpreter either, only the folder of every uv-managed Python,
 * so it is the same with and without `--skip-install`. The agent calls Bedrock
 * in `region`, the one create resolved.
 */
export function renderBoxProfile(
  projectName: string,
  runtime: ScaffoldRuntimeInput,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
) {
  if (!hasBoxProfile(runtime)) return undefined;

  const protocol = runtime.protocol ?? "HTTP";
  const appDir = `\${{ workspace }}/app/${runtime.runtimeName}`;
  const ingressPort = boxIngressPort(protocol);
  const workloadPort = ingressPort + 1;
  const runner = codeZipRunner(protocol, appDir, workloadPort);
  const callsModel = protocol !== "MCP";
  const bedrock = callsModel && callsBedrockModel(runtime);
  const keyed = callsModel ? apiKeyRoute(runtime) : undefined;
  const environment = { LOCAL_DEV: "1", ...runner.env, ...PYTHON_ENV };

  // The optional sections, each empty or ending in a newline.
  const header = `# Written by \`agentcore create\`. Run \`box run ${BOX_PROFILE_FILE}\` in the project folder.`;
  const regionComment =
    "# The AWS region `agentcore create` resolved. Change it to call Bedrock in another region\n" +
    "# under `agentcore dev`; build and deploy set the region they deploy to.\n";
  const options = bedrock ? `[options]\n${regionComment}bedrock.region = ${str(region)}\n\n` : "";
  const bedrockRoute = bedrock
    ? `
# Sign the model calls with your default AWS profile, as \`agentcore dev\` does without a box,
# rather than with the Bedrock API key that box/bedrock reads from AWS_BEARER_TOKEN_BEDROCK.
[egress.bedrock]
secret.ref = "aws://default"
`
    : "";
  const keyedRoute = keyed ? apiKeyRouteSection(keyed, apiKeyVariable(runtime, keyed)) : "";
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
listen = ${str(`127.0.0.1:${ingressPort}`)}
workload_port = ${workloadPort}
${bedrockRoute}${keyedRoute}`;
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
    // With no provider prefix (`gpt-4o`), LiteLLM guesses the provider, so the section has no
    // name to suggest; a prefix the profile knows gets its route without editing.
    const [prefix, model] = modelId.split("/");
    const section = model === undefined ? "[egress.<provider>]" : `[egress.${prefix}]`;
    const prefixHint =
      model === undefined ? " (or use an openai/, anthropic/ or gemini/ model ID)" : "";
    return [
      `the box profile has no route for the LiteLLM model '${modelId}': add an ` +
        `${section} section with its provider's host to ${BOX_PROFILE_FILE}${prefixHint}, or the ` +
        "box blocks the agent's model calls",
    ];
  }
  if (runtime.apiKey !== undefined || route.providerVariable === undefined) return [];
  return [
    `the box profile reads the ${route.name} API key from ${route.providerVariable}: set it in ` +
      "agentcore/.env.local or your shell before `agentcore dev`, or the agent's model calls " +
      "go out with no key",
  ];
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
