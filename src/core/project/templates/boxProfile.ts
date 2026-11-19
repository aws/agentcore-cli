import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { ProjectStateError } from "../../../errors/errors";
import {
  DEFAULT_EGRESS_BEDROCK_REGION,
  callsBedrockModel,
} from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { memoryEnvVarName } from "../../../projectSchemas/memory";
import { isBoxProject, type ProjectSpec } from "../../../projectSchemas/project";
import { DEFAULT_MODEL_IDS, type ProjectRuntime } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";
import { PYTHON_ENV } from "../../dev/codezip";
import { modelProviderCredentialName } from "./runtime";

/** Where a box template's venv gets its uv-managed Python, relative to the home folder. */
const UV_PYTHON_HOME_DIR = ".local/share/uv/python";

/** That folder as a boxy path. */
const UV_PYTHON_INSTALL_DIR = "${{ home }}/" + UV_PYTHON_HOME_DIR;

/** The system libraries of the Linux arm64 image, such as libssl. */
const LINUX_LIBRARIES = "/usr/lib/aarch64-linux-gnu";

/**
 * The environment `uv sync` builds a box template's venv with: a uv-managed Python, installed in
 * the folder the profile grants, so a user's UV_PYTHON_INSTALL_DIR or XDG_DATA_HOME cannot move
 * it out of the grant.
 */
export function boxUvSyncEnv(home: string): Record<string, string> {
  return { UV_MANAGED_PYTHON: "1", UV_PYTHON_INSTALL_DIR: join(home, UV_PYTHON_HOME_DIR) };
}

/**
 * The entry point of a runtime that runs its agent in a box on a CodeZip
 * deploy: start.py starts `box run`. Create writes it.
 */
export const BOX_CODEZIP_ENTRYPOINT = "start.py";

/** The folder deploy stages box into, inside the runtime's code folder, so it ships in the zip. */
export const BOX_CODEZIP_DIST = ".box-dist";

/** The Runtime sets the gateway URL; start.py exports the CodeZip paths only the microVM knows. */
const BOX_GATEWAY_URL_ENV = "AGENTCORE_GATEWAY_BOX_URL";
const BOX_PYTHON_ENV = "BOX_PYTHON";
const BOX_PYTHON_PREFIX_ENV = "BOX_PYTHON_PREFIX";
const BOX_CODE_ENV = "BOX_CODE";

/**
 * The variable in which AgentCore Runtime names the runtime's own log group and log stream, as
 * `x-aws-log-group=<group>,x-aws-log-stream=<stream>`, with other keys.
 */
const RUNTIME_LOGS_HEADERS_ENV = "OTEL_EXPORTER_OTLP_LOGS_HEADERS";

/** {@link renderAgentCorePack}. */
export const AGENTCORE_PACK_NAME = "box/agentcore";
export const AGENTCORE_PACK_PATH = "resources/packs/agentcore/pack.toml";

/** {@link renderAgentCoreCodeZipPack}. */
export const AGENTCORE_CODEZIP_PACK_NAME = "box/agentcore-codezip";
export const AGENTCORE_CODEZIP_PACK_PATH = "resources/packs/agentcore-codezip/pack.toml";

/**
 * box requires a `pattern` on an input that reaches a backend `url`. The CDK sets the gateway URL
 * with a `/mcp` path, so a path is allowed after the host. `[.]` is a literal dot, because a TOML
 * basic string rejects `\.`.
 */
const GATEWAY_URL_PATTERN =
  "https://[a-z0-9][-a-z0-9.]*[.]amazonaws[.]com(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*";

/** As box/bedrock bounds `bedrock.region`. */
const AWS_REGION_PATTERN = "[a-z]{2}(-[a-z]+)?-(central|north|south|east|west)+-[0-9]+";

/**
 * For the inputs that reach the agent `command` or a filesystem grant: no extra arguments, and no
 * `.` or `..` segment, empty value or `/`, which would widen a grant to `/`.
 */
const ABSOLUTE_PATH_PATTERN = "(/[.]{0,2}[A-Za-z0-9_+-][A-Za-z0-9_.+-]*)+";

/**
 * The tools of box/base that get the project's write grant: box gives each one its own grant, so
 * each lists the agent's `deny_write` folders as well. Taken from box/base in the box release that
 * `boxRelease.json` pins (0.1.11-linux-preview.6). When the pin moves, check box/base's tools: box
 * refuses a CodeZip box profile if a tool it misses gets the project write grant.
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

/** The `[profile] name` of an agent's local box profile: the project's name, then the agent's. */
export function boxLocalProfileName(projectName: string, agentName: string): string {
  return `${projectName}-${agentName}`;
}

/** An agent's local box profile at `projectRoot`. */
export function boxLocalProfilePath(projectRoot: string, agentName: string): string {
  return join(projectRoot, boxLocalProfileFile(agentName));
}

/** The one box profile of a project in the layout before each agent had its own. */
const PROJECT_BOX_PROFILE_FILE = posix.join(BOX_ROOT, "profile.toml");

/**
 * Throws when the project at `projectRoot` keeps `.box/profile.toml`, the one box profile of the
 * earlier layout, which no command reads now.
 */
export function assertNoProjectBoxProfile(projectRoot: string): void {
  if (!existsSync(join(projectRoot, ...PROJECT_BOX_PROFILE_FILE.split("/")))) return;
  throw new ProjectStateError(
    `${PROJECT_BOX_PROFILE_FILE} is the box profile of an earlier layout, and no command reads ` +
      `it now: each agent has its own profile, ${boxLocalProfileFile("<runtime>")}. Move the ` +
      "profile and its policy files into that folder of the runtime it runs, then remove " +
      `${PROJECT_BOX_PROFILE_FILE}.`,
  );
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
    runtime.boxTemplate === true &&
    runtime.build === "Container" &&
    runtime.language === "Python" &&
    runtime.framework === "strands"
  );
}

/** The frameworks whose Python CodeZip agent the box profile can serve. */
const CODEZIP_BOX_FRAMEWORKS: ReadonlySet<ScaffoldRuntimeInput["framework"]> = new Set([
  "strands",
  "langchain",
  "none",
]);

/**
 * Whether create writes the box start script, start.py, so a CodeZip deploy runs the agent in a
 * box: a Python CodeZip box template. The box serves the protocol's port, which the profile's
 * ingress names.
 */
export function startsInBoxOnCodeZip(runtime: ScaffoldRuntimeInput): boolean {
  return (
    runtime.boxTemplate === true &&
    runtime.build === "CodeZip" &&
    runtime.language === "Python" &&
    CODEZIP_BOX_FRAMEWORKS.has(runtime.framework)
  );
}

/**
 * Whether a runtime runs its agent in a box: in a Box project (`boxProject`, which is
 * `"projectType": "box"`), a runtime with `box.version`, which `agentcore create` writes only for
 * a box template. Build, deploy and dev decide this here and nowhere else. The entry point and the
 * Dockerfile say only how box starts, so a user's own `start.py` or Dockerfile never makes a
 * runtime boxed.
 */
export function runsInBox(boxProject: boolean, runtime: Pick<ProjectRuntime, "box">): boolean {
  return boxProject && runtime.box !== undefined;
}

/** {@link runsInBox} for a runtime of `spec`. */
export function runtimeRunsInBox(spec: ProjectSpec, runtime: ProjectRuntime): boolean {
  return runsInBox(isBoxProject(spec), runtime);
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
const OPENAI_COMPATIBLE_ROUTE = "openai-compatible";

/**
 * The `[egress.<name>]` routes `agentcore create` writes for a model provider's API key. Their key
 * is the project's model-provider credential, which `create` declares when it is given a key, or
 * else a provider variable that LiteLLM reads; build does not declare a credential for them.
 */
export const MODEL_PROVIDER_EGRESS_ROUTES: ReadonlySet<string> = new Set([
  OPENAI.name,
  ANTHROPIC.name,
  GEMINI.name,
  OPENAI_COMPATIBLE_ROUTE,
]);

/** The provider variables a model-provider route reads its key from when `create` had no key. */
export const MODEL_PROVIDER_KEY_VARIABLES: ReadonlySet<string> = new Set(
  [OPENAI, ANTHROPIC, GEMINI].flatMap(({ providerVariable }) =>
    providerVariable === undefined ? [] : [providerVariable],
  ),
);

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
        : { name: OPENAI_COMPATIBLE_ROUTE, host: new URL(runtime.apiBase).host };
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

/** A filesystem grant: a path, or a path that box skips when it does not exist. */
type Grant = string | { readonly path: string; readonly optional: true };

/** A grant that box skips when the path does not exist, such as a venv not yet installed. */
const optionalGrant = (path: string): Grant => ({ path, optional: true });

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
  read: Grant[];
  exec: Grant[];
  denyWrite: Grant[];
};

/** A CodeZip agent: its code and venv are in the project's app/<runtime> folder. */
function codeZipRunner(protocol: Protocol, appDir: string, workloadPort: number): Runner {
  const { command, env } = serve(protocol, appDir, workloadPort, true);
  // Create runs `uv sync` with boxUvSyncEnv, so the venv links to a Python in this folder.
  // Optional, so a venv rebuilt on another Python still starts; that Python then needs its own grant.
  const uvPython = optionalGrant(UV_PYTHON_INSTALL_DIR);
  return {
    command,
    env: { LOCAL_DEV: "1", ...env },
    read: [appDir, optionalGrant(`${appDir}/.venv`), uvPython],
    exec: [optionalGrant(`${appDir}/.venv`), uvPython],
    denyWrite: [optionalGrant(`${appDir}/.venv`)],
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
    read: [appDir, "/usr/local/lib", LINUX_LIBRARIES],
    exec: [optionalGrant(`${appDir}/.venv`), "/usr/local/bin", "/usr/local/lib", LINUX_LIBRARIES],
    denyWrite: [optionalGrant(`${appDir}/.venv`)],
  };
}

/**
 * A CodeZip agent on AgentCore Runtime, in the paths of the local profile: the paths rule of the
 * Runtime profile derivation moves them to the Runtime's code folder and Python. It does not
 * reload. Box Core adds the loader folders itself and refuses exec on them, so they are read only.
 * One grant may not sit inside another, so the Python's prefix covers its bin/ folder. The box
 * starts in a writable folder outside the code, so nothing the agent runs needs `deny_write`.
 */
function runtimeCodeZipRunner(protocol: Protocol, appDir: string, workloadPort: number): Runner {
  const { command, env } = serve(protocol, appDir, workloadPort, false);
  return {
    command,
    env,
    read: [appDir, UV_PYTHON_INSTALL_DIR, "/usr/lib64", "/lib64"],
    exec: [appDir, UV_PYTHON_INSTALL_DIR],
    denyWrite: [],
  };
}

/**
 * The box profile that `agentcore dev` runs for the scaffolded agent, or `undefined` when the
 * template has none. It holds no host path: box fills `${{ workspace }}` (the folder `box run`
 * starts in) and `${{ home }}` at run time. On a Mac, box starts in the project root and names no
 * interpreter, only the folder of every uv-managed Python, so it is the same with and without
 * `--skip-install`. The agent calls Bedrock in `region`, the one create resolved. The container
 * template's runs in its dev image, in /app. Build and deploy derive the AgentCore Runtime profile
 * from it (runtimeProfile/derive.ts).
 */
export function renderBoxProfile(
  projectName: string,
  runtime: ScaffoldRuntimeInput,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
) {
  if (!hasBoxProfile(runtime)) return undefined;

  const protocol = runtime.protocol ?? "HTTP";
  const ingressPort = boxIngressPort(protocol);
  const workloadPort = boxWorkloadPort(protocol);
  const container = isBoxedContainer(runtime);
  // The image's agent reads /app and writes nothing there. Build resolves the profile on the host,
  // where the image's /app/.venv does not exist, so a write grant would leave its Python unprotected
  // and box would refuse the profile. A CodeZip agent writes in the folder box starts in.
  const projectSection = container
    ? '# The agent, and the tools its packs add, can read the folder box starts in.\n[project]\naccess = "read"\n'
    : '# The agent, and the tools its packs add, can read and write the folder box starts in.\n[project]\naccess = "write"\n';
  const runner = container
    ? containerRunner(workloadPort, true)
    : codeZipRunner(protocol, boxAppDir(runtime), workloadPort);
  // In an image, the port is reached on the machine's own address.
  const listenHost = container ? "0.0.0.0" : "127.0.0.1";
  const bedrock = writesBedrockRoute(runtime);
  const keyed = protocol !== "MCP" ? apiKeyRoute(runtime) : undefined;
  const environment = { ...runner.env, ...PYTHON_ENV };

  // The optional sections, each empty or ending in a newline.
  const header = container
    ? "# Written by `agentcore create` for the agent's image, to run with `box run` in /app."
    : `# Written by \`agentcore create\` or \`agentcore add runtime\`. Run \`box run ${boxLocalProfileFile(runtime.runtimeName)}\` in the project folder.`;
  const options = bedrock
    ? "[options]\n" +
      "# The AWS region `agentcore create` resolved. Change it to call Bedrock in another region\n" +
      "# under `agentcore dev`; build and deploy set the region they deploy to.\n" +
      `bedrock.region = ${str(region)}\n\n`
    : "";
  const denyWrite = runner.denyWrite.length > 0 ? `deny_write = ${grants(runner.denyWrite)}\n` : "";
  // box refuses to run a program from a folder that any process in the box can write, so each
  // tool that gets the project's write grant lists the venv too.
  const toolDenyWrite =
    !container && runner.denyWrite.length > 0
      ? BOX_BASE_PROJECT_WRITE_TOOLS.map(
          (tool) => `\n[tool.${tool}.filesystem]\ndeny_write = ${grants(runner.denyWrite)}\n`,
        ).join("")
      : "";
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

  // box keeps one profile of each name on a machine, so each runtime's local profile has its own.
  return `# Runs the agent of the AgentCore project '${projectName}' in a box.
${header}
packs = ${packs}

[profile]
name = ${str(boxLocalProfileName(projectName, runtime.runtimeName))}

${projectSection}
${options}[agent]
command = ${list(runner.command)}

[agent.env]
${env}

[agent.filesystem]
read = ${grants(runner.read)}
exec = ${grants(runner.exec)}
${denyWrite}
[[agent.ingress]]
listen = ${str(`${listenHost}:${ingressPort}`)}
workload_port = ${workloadPort}
${toolDenyWrite}${bedrockRoute}${keyedRoute}`;
}

/** The code folder of a box template's agent in its local profile: `${{ workspace }}/app/<name>`. */
function boxAppDir(runtime: ScaffoldRuntimeInput): string {
  return `\${{ workspace }}/app/${runtime.runtimeName}`;
}

/**
 * The `[agent]` table of a box template's agent on AgentCore Runtime, or `undefined` when the
 * template has none: what the additions rule of the Runtime profile derivation gives each value
 * that is the template's own. It names the paths of the local profile, which the paths rule then
 * moves. It differs from the local `[agent]` only where the Runtime needs it: no reload and no
 * `LOCAL_DEV`, the ingress on every address, and for CodeZip the Runtime's loader folders read and
 * no `deny_write`.
 */
export function runtimeAgentTemplate(
  runtime: ScaffoldRuntimeInput,
): Record<string, unknown> | undefined {
  if (!hasBoxProfile(runtime)) return undefined;
  const protocol = runtime.protocol ?? "HTTP";
  const workloadPort = boxWorkloadPort(protocol);
  const runner = isBoxedContainer(runtime)
    ? containerRunner(workloadPort, false)
    : runtimeCodeZipRunner(protocol, boxAppDir(runtime), workloadPort);
  return {
    command: runner.command,
    env: { ...runner.env, ...PYTHON_ENV },
    filesystem: {
      read: runner.read,
      exec: runner.exec,
      ...(runner.denyWrite.length > 0 && { deny_write: runner.denyWrite }),
    },
    ingress: [{ listen: `0.0.0.0:${boxIngressPort(protocol)}`, workload_port: workloadPort }],
  };
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
        `${section} section with its provider's host to ` +
        `${boxLocalProfileFile(runtime.runtimeName)}${prefixHint}, or the ` +
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

/**
 * The `box/agentcore` pack each Runtime profile imports, CodeZip and container: it declares the
 * inputs the profile reads from the environment the Runtime sets after deploy. The `aws.region`
 * input carries the Runtime's region into the agent's environment. The `gateway.url` input fills each
 * egress backend `url`, bounded by a pattern so a value from the environment names only the host the
 * profile expects. The `runtime.log_group` and `runtime.log_stream` inputs each read one key of
 * {@link RUNTIME_LOGS_HEADERS_ENV}, for the default telemetry target of the Runtime profile. One
 * input per project memory carries its ID into the agent's environment. box finds the pack beside
 * its binary at {@link AGENTCORE_PACK_PATH}; build and deploy stage it there.
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
pattern = ${str(GATEWAY_URL_PATTERN)}

# The Runtime's region, which box signs each Box gateway backend for and passes to the agent. The
# Runtime sets AWS_REGION.
[inputs.aws.region]
description = "The AWS region the runtime runs in."
from = "env:AWS_REGION"
pattern = ${str(AWS_REGION_PATTERN)}

# The runtime's own log group and log stream, for the default telemetry target. The runtime ID
# exists only after deploy, and the Runtime names both in ${RUNTIME_LOGS_HEADERS_ENV}.
[inputs.runtime.log_group]
description = "The runtime's own CloudWatch Logs log group."
from = ${str(`env:${RUNTIME_LOGS_HEADERS_ENV}`)}
key = "x-aws-log-group"

[inputs.runtime.log_stream]
description = "The runtime's own CloudWatch Logs log stream."
from = ${str(`env:${RUNTIME_LOGS_HEADERS_ENV}`)}
key = "x-aws-log-stream"${memoryInputs}
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
pattern = ${str(ABSOLUTE_PATH_PATTERN)}

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

/** A list of filesystem grants as TOML. */
function grants(values: readonly Grant[]): string {
  const grant = (value: Grant) =>
    typeof value === "string" ? str(value) : `{ path = ${str(value.path)}, optional = true }`;
  return `[${values.map(grant).join(", ")}]`;
}

function list(values: string[]): string {
  return `[${values.map(str).join(", ")}]`;
}

/**
 * A TOML key: bare when TOML allows it, else a quoted string. Defensive: AgentCore Gateway takes
 * only target names of letters, digits and single dashes, which are bare keys already.
 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : str(key);
}

/**
 * Whether the profile has the `[egress.bedrock]` route: the agent calls a Bedrock model, which an
 * MCP server does not.
 */
function writesBedrockRoute(runtime: ScaffoldRuntimeInput): boolean {
  return (runtime.protocol ?? "HTTP") !== "MCP" && callsBedrockModel(runtime);
}
