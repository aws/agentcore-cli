import { join, posix } from "node:path";
import semver from "semver";
import { callsBedrockModel } from "../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { memoryEnvVarName } from "../../../projectSchemas/memory";
import { isBoxProject, type ProjectSpec } from "../../../projectSchemas/project";
import { DEFAULT_MODEL_IDS, type ProjectRuntime } from "../../../projectSchemas/runtime";
import { DEV_PORTS } from "../../dev/port";
import { PYTHON_ENV } from "../../dev/codezip";
import { BOX_RELEASE } from "../backends/boxRelease";
import { modelProviderCredentialName } from "./runtime";
import { projectGatewayInputs, type BoxProjectGateway } from "../boxNetwork/projectGateways";

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
const BOX_PYTHON_STDLIB_ENV = "BOX_PYTHON_STDLIB";
const BOX_CODE_ENV = "BOX_CODE";

/**
 * The variable in which AgentCore Runtime names the runtime's own log group and log stream, as
 * `x-aws-log-group=<group>,x-aws-log-stream=<stream>`, with other keys.
 */
export const RUNTIME_LOGS_HEADERS_ENV = "OTEL_EXPORTER_OTLP_LOGS_HEADERS";

/**
 * The variable in which AgentCore Runtime names the runtime's own log group and the log stream of
 * its spans, as `x-aws-log-group=<group>,x-aws-log-stream=<stream>`, with other keys.
 */
export const RUNTIME_TRACES_HEADERS_ENV = "OTEL_EXPORTER_OTLP_TRACES_HEADERS";

/**
 * The first box release whose `cloudwatch_traces` target takes `log_group` and `log_stream`
 * (strands-agents/box#629). Set it to the release that ships that change.
 */
export const BOX_TRACES_LOG_GROUP_VERSION = "0.3.2";

/** Whether box `version`, by default the staged box, takes the log group of its spans. */
export function tracesToRuntimeLogGroup(version: string = BOX_RELEASE.version): boolean {
  const valid = semver.valid(version);
  return valid !== null && semver.gte(valid, BOX_TRACES_LOG_GROUP_VERSION);
}

/** The pack of box that each box profile imports. */
const BOX_BASE_PACK = "@box/base";

/** The pack of box that routes the Bedrock model calls, with its `[options] bedrock.region`. */
export const BOX_BEDROCK_PACK = "@box/bedrock";

/**
 * The route of {@link BOX_BEDROCK_PACK} that signs each Bedrock call with the AWS credentials,
 * `aws://`, for its `bedrock.sign-in` input `aws`, the default. The local profile uses it.
 */
export const BOX_BEDROCK_ROUTE = "bedrock";

/**
 * The route of {@link BOX_BEDROCK_PACK} for its `bedrock.sign-in` input `api-key`, whose secret is
 * `env://AWS_BEARER_TOKEN_BEDROCK`. The Runtime profile uses it: there each Bedrock call goes
 * through a Box gateway backend, and box takes only an `env://` secret beside a backend. Box gives
 * the agent a stand-in for it and strips it, and the gateway signs the call with its own role.
 */
export const BOX_BEDROCK_API_KEY_ROUTE = "bedrock-api-key";

/** The `bedrock.sign-in` of the Runtime profile, which selects {@link BOX_BEDROCK_API_KEY_ROUTE}. */
export const BOX_BEDROCK_RUNTIME_SIGN_IN = "api-key";

/** {@link renderAgentCorePack}. */
export const AGENTCORE_PACK_NAME = "@box/agentcore";
export const AGENTCORE_PACK_PATH = "resources/packs/agentcore/pack.toml";

/** {@link renderAgentCoreCodeZipPack}. */
export const AGENTCORE_CODEZIP_PACK_NAME = "@box/agentcore-codezip";
export const AGENTCORE_CODEZIP_PACK_PATH = "resources/packs/agentcore-codezip/pack.toml";

/**
 * box requires a `pattern` on an input that reaches a backend `url`. The CDK sets the gateway URL
 * with a `/mcp` path, so a path is allowed after the host. `[.]` is a literal dot, because a TOML
 * basic string rejects `\.`.
 */
const GATEWAY_URL_PATTERN =
  "https://[a-z0-9][-a-z0-9.]*[.]amazonaws[.]com(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*";

/**
 * The host of a gateway of the project, which the CDK library sets in `<prefix>_HOST`, and that
 * gateway's URL in `<prefix>_URL`, with `/mcp` for an MCP gateway, in the `aws` and `aws-cn`
 * partitions. Each input that reaches a route's destinations needs a pattern.
 */
const PROJECT_GATEWAY_HOST_PATTERN =
  "[a-z0-9][-a-z0-9]*[.]gateway[.]bedrock-agentcore[.][a-z0-9-]+[.]amazonaws[.]com([.]cn)?";
const PROJECT_GATEWAY_URL_PATTERN = `https://${PROJECT_GATEWAY_HOST_PATTERN}(/mcp)?`;

/** As @box/bedrock bounds `bedrock.region`. */
const AWS_REGION_PATTERN = "[a-z]{2}(-[a-z]+)?-(central|north|south|east|west)+-[0-9]+";

/**
 * For the inputs that reach the agent `command` or a filesystem grant: no extra arguments, and no
 * `.` or `..` segment, empty value or `/`, which would widen a grant to `/`.
 */
const ABSOLUTE_PATH_PATTERN = "(/[.]{0,2}[A-Za-z0-9_+-][A-Za-z0-9_.+-]*)+";

/**
 * The tools of @box/base that get the project's write grant: box gives each one its own grant,
 * so each lists the agent's `deny_write` folders as well. Taken from @box/base in the box release
 * that `boxRelease.json` pins (0.3.0), which has no tools: it
 * dropped `uname`, and refuses a
 * `[tool.uname]` table with no `command`. When the pin moves, check the tools of @box/base: box
 * refuses a CodeZip box profile if a tool it misses gets the project write grant.
 */
const BOX_BASE_PROJECT_WRITE_TOOLS: readonly string[] = [];

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
function boxLocalProfileName(projectName: string, agentName: string): string {
  return `${projectName}-${agentName}`;
}

/**
 * The policy file that each box profile `agentcore create` or `agentcore add runtime` writes lists
 * under `policies`, beside the profile. While the profile lists it, build copies it beside the
 * AgentCore Runtime profile, so its forbids hold there too. It has a name of its own, so
 * `policy.dw`, the name Box gives the policy a user edits, stays free for the user.
 */
export const AWS_METADATA_POLICY_FILE = "aws-metadata-block.dw";

/** The `@id`s of the rules of {@link AWS_METADATA_POLICY_FILE}. */
export const AWS_METADATA_RULE_IDS: ReadonlySet<string> = new Set([
  "aws_metadata_addresses",
  "aws_metadata_hosts",
]);

/** An agent's {@link AWS_METADATA_POLICY_FILE} at `projectRoot`, beside its local box profile. */
export function boxLocalMetadataPolicyPath(projectRoot: string, agentName: string): string {
  return join(projectRoot, boxLocalDir(agentName), AWS_METADATA_POLICY_FILE);
}

/**
 * The text of {@link AWS_METADATA_POLICY_FILE}: forbids on a connection to the AWS instance metadata
 * service (IMDS on EC2, MMDS on AgentCore Runtime), which serves the role's credentials. A forbid
 * wins over every permit, so these hold even when a route or a rule the user adds permits the host.
 * Build copies the file into the AgentCore Runtime profile, so Box refuses these connections there
 * too, and a route to one of these hosts gets no gateway target.
 */
export function renderAwsMetadataPolicy(): string {
  return `// Written by \`agentcore create\` or \`agentcore add runtime\`, which replace this file each time
// they write the box profile beside it. The profile lists it under \`policies\`, and build copies
// it beside the AgentCore Runtime profile. Put rules of your own in another file beside the
// profile, such as policy.dw, and add it to \`policies\`.

// The agent cannot connect to the AWS instance metadata service, which serves the role's
// credentials: 169.254.169.254 and fd00:ec2::254 (IMDS on EC2, MMDS on AgentCore Runtime), and the
// names instance-data and instance-data.ec2.internal. Box's gateway, outside the box, signs the
// agent's AWS calls, so the agent needs no credentials of its own. Other link-local addresses and
// the metadata services of other clouds are not forbidden here.
@id("aws_metadata_addresses")
forbid (principal, action == Box::Action::"net:connect", resource)
when {
  (context.input has ip4 && context.input.ip4 == "169.254.169.254") ||
  (context.input has ip6 && context.input.ip6 == "fd00:ec2::254")
};

@id("aws_metadata_hosts")
forbid (principal, action == Box::Action::"net:connect", resource)
when {
  context.input.host == "169.254.169.254" ||
  context.input.host == "instance-data" ||
  context.input.host == "instance-data.ec2.internal"
};
`;
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

/**
 * The code folder of a CodeZip box template in its local profile: `agentcore dev` starts box in
 * the folder of the runtime, so the profile names it as `${{ workspace }}`.
 */
const CODEZIP_START_FOLDER = "${{ workspace }}";

/** The URL an A2A agent card advertises on the Runtime, from an input of @box/agentcore. */
const RUNTIME_URL = "${{ inputs.runtime.url }}";

/**
 * The folder, from the project root, that box starts a run or a resolution of `runtime`'s local
 * profile in: the runtime's own code folder for a CodeZip runtime, from agentcore.json, so the
 * agent's grants reach no further than it, whatever the profile says. The project root ("") for a
 * container runtime, whose profile describes the image's /app.
 */
export function boxStartFolder(runtime: {
  readonly build: string;
  readonly codeLocation: string;
}): string {
  if (runtime.build !== "CodeZip") return "";
  return runtime.codeLocation.replace(/^\.\/+/, "").replace(/\/+$/, "");
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

/**
 * The variable that turns off the observability of a runtime on AgentCore Runtime. When the envVars
 * of the runtime set it to `true`, the Runtime profile gets no default log target, and the agent
 * gets no OTEL ({@link otelOn}).
 */
export const OBSERVABILITY_OFF_ENV = "DISABLE_ADOT_OBSERVABILITY";

/** Whether the envVars of `runtime` set {@link OBSERVABILITY_OFF_ENV} to `true`. */
export function observabilityOff(runtime: Pick<ProjectRuntime, "envVars">): boolean {
  return (runtime.envVars ?? []).some(
    ({ name, value }) => name === OBSERVABILITY_OFF_ENV && value.trim().toLowerCase() === "true",
  );
}

/**
 * Whether the agent of `runtime` sends OTEL on AgentCore Runtime: `instrumentation.enableOtel`,
 * which is `true` when absent, and the envVars do not turn observability off. It decides the
 * opentelemetry-instrument start, the ADOT variables, and the default X-Ray target together.
 */
export function otelOn(runtime: Pick<ProjectRuntime, "instrumentation" | "envVars">): boolean {
  return (runtime.instrumentation?.enableOtel ?? true) && !observabilityOff(runtime);
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
  cardUrl = `http://localhost:${boxIngressPort(protocol)}/`,
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
  // box starts the agent in the folder it runs in (the runtime's own, locally), and refuses a
  // script path inside it, so the module is found through PYTHONPATH. `agentcore dev` runs these
  // without a reload too.
  const portVariable = { AGUI: "PORT", A2A: "A2A_PORT", MCP: "FASTMCP_PORT" }[protocol];
  // serve_a2a puts its listen port in the agent card's URL, and AGENTCORE_RUNTIME_URL takes
  // precedence. Locally, callers reach the agent only through box's ingress port, so the card names
  // that port; on the Runtime, `cardUrl` is the Runtime's own value (see renderAgentCorePack).
  const card: Record<string, string> = protocol === "A2A" ? { AGENTCORE_RUNTIME_URL: cardUrl } : {};
  return {
    command: [python, "-m", "main"],
    env: { PYTHONPATH: appDir, [portVariable]: String(workloadPort), ...card },
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
  const appDir = CODEZIP_START_FOLDER;
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
 * Runtime profile derivation moves them to the Runtime's code folder, Python, and standard library.
 * It does not reload. Box Core adds the loader folders itself and refuses exec on them, so they are
 * read only. The box starts in a writable folder outside the code, so nothing the agent runs needs
 * `deny_write`.
 */
function runtimeCodeZipRunner(protocol: Protocol, appDir: string, workloadPort: number): Runner {
  // An A2A agent card advertises the URL of the Runtime, which @box/agentcore reads.
  const { command, env } = serve(protocol, appDir, workloadPort, false, undefined, RUNTIME_URL);
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
 * starts in) and `${{ home }}` at run time. For a CodeZip agent, box starts in the runtime's
 * folder, `app/<runtime>`, and the profile names no interpreter, only the folder of every
 * uv-managed Python, so it is the same with and without `--skip-install`. The agent calls Bedrock
 * in `region`, the one create resolved. The container template's runs in its dev image, in /app.
 * Build and deploy derive the AgentCore Runtime profile from it (runtimeProfile/derive.ts).
 */
export function renderBoxProfile(
  projectName: string,
  runtime: ScaffoldRuntimeInput,
  region: string,
) {
  if (!hasBoxProfile(runtime)) return undefined;

  const protocol = runtime.protocol ?? "HTTP";
  // `agentcore dev` starts box in the runtime's folder, so the agent can read and write that folder
  // and nothing else of the project: not agentcore/.env.local, with the model's key, nor .git or
  // agentcore/cdk, which run outside the box.
  const codeFolder = `app/${runtime.runtimeName}`;
  const appDir = "${{ workspace }}";
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
    : codeZipRunner(protocol, appDir, workloadPort);
  // In an image, the port is reached on the machine's own address.
  const listenHost = container ? "0.0.0.0" : "127.0.0.1";
  const bedrock = writesBedrockRoute(runtime);
  const keyed = protocol !== "MCP" ? apiKeyRoute(runtime) : undefined;
  const environment = { ...runner.env, ...PYTHON_ENV };

  // The optional sections, each empty or ending in a newline.
  const header = container
    ? "# Written by `agentcore create` for the agent's image, to run with `box run` in /app."
    : `# Written by \`agentcore create\` or \`agentcore add runtime\` for ${codeFolder}: ` +
      `\`agentcore dev\` runs \`box run ${posix.relative(codeFolder, boxLocalProfileFile(runtime.runtimeName))}\` ` +
      "there, so the agent can reach no other folder of the project.";
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
# Sign the model calls with the AWS default credential chain, as \`agentcore dev\` does without a
# box, rather than with the Bedrock API key that @box/bedrock reads from AWS_BEARER_TOKEN_BEDROCK.
[egress.bedrock]
secret.ref = "aws://"
`
    : "";
  const keyedRoute = keyed ? apiKeyRouteSection(keyed, apiKeyVariable(runtime, keyed)) : "";
  const packs = list([BOX_BASE_PACK, ...(bedrock ? [BOX_BEDROCK_PACK] : [])]);
  const env = Object.entries(environment)
    .map(([name, value]) => `${name} = ${str(value)}`)
    .join("\n");

  // box keeps one profile of each name on a machine, so each runtime's local profile has its own.
  return `# Runs the agent of the AgentCore project '${projectName}' in a box.
${header}
packs = ${packs}
# The policy files whose rules box loads, beside this profile. ${AWS_METADATA_POLICY_FILE} keeps the
# agent from the AWS instance metadata service. Put rules of your own in another file beside it,
# such as policy.dw, and add it to this list.
policies = ${list([AWS_METADATA_POLICY_FILE])}

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
    : runtimeCodeZipRunner(protocol, CODEZIP_START_FOLDER, workloadPort);
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
 * The variables that set up the ADOT SDK of an agent with OTEL on: the AWS distro and its
 * configurator, spans and logs over OTLP to the box's own receiver (box sets each
 * `OTEL_EXPORTER_OTLP_*`), no metrics, and no span for each health check of the Runtime.
 */
const AGENT_OTEL_ENV: Readonly<Record<string, string>> = {
  OTEL_PYTHON_DISTRO: "aws_distro",
  OTEL_PYTHON_CONFIGURATOR: "aws_configurator",
  AGENT_OBSERVABILITY_ENABLED: "true",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_PYTHON_EXCLUDED_URLS: "/ping",
};

/** The variable in which AgentCore Runtime names the resource of the runtime's spans. */
const RUNTIME_RESOURCE_ATTRIBUTES_ENV = "OTEL_RESOURCE_ATTRIBUTES";

/**
 * The `@box/agentcore` pack each Runtime profile imports, CodeZip and container: it declares the
 * inputs the profile reads from the environment the Runtime sets after deploy. The `aws.region`
 * input carries the Runtime's region into the agent's environment. The `gateway.url` input fills each
 * egress backend `url`, bounded by a pattern so a value from the environment names only the host the
 * profile expects. The `runtime.log_group` and `runtime.log_stream` inputs each read one key of
 * {@link RUNTIME_LOGS_HEADERS_ENV}, for the default telemetry target of the Runtime profile. With
 * OTEL on and {@link tracesToRuntimeLogGroup}, the `runtime.traces_log_group` and
 * `runtime.traces_log_stream` inputs each read one key of {@link RUNTIME_TRACES_HEADERS_ENV}, for
 * the default X-Ray target. One
 * input per project memory carries its ID into the agent's environment. With OTEL on for `runtime`,
 * the agent gets {@link AGENT_OTEL_ENV} and the Runtime's resource attributes, so the console links
 * its spans to the runtime; the profile merges after the pack, so a value of the user wins. Each
 * gateway of the project that the agent calls through the Box gateway gets two inputs: its host,
 * for the destination of its `[mcp]` server, and its URL, which the agent gets under the variable
 * name that a runtime without a box reads. box finds the pack beside its binary at
 * {@link AGENTCORE_PACK_PATH}; build and deploy stage it there.
 */
export function renderAgentCorePack(
  spec: ProjectSpec,
  runtime: Pick<ProjectRuntime, "name" | "instrumentation" | "envVars">,
  gateways: readonly BoxProjectGateway[] = [],
  boxVersion?: string,
): string {
  const otel = otelOn(runtime);
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
  const otelEnv = otel
    ? [
        ...Object.entries(AGENT_OTEL_ENV).map(([name, value]) => `${name} = ${str(value)}`),
        `${RUNTIME_RESOURCE_ATTRIBUTES_ENV} = "\${{ inputs.runtime.resource_attributes }}"`,
      ].join("\n")
    : "";
  const otelInput = otel
    ? `

# The resource of the agent's spans, which the Runtime names so the console links them to it.
[inputs.runtime.resource_attributes]
description = "The OpenTelemetry resource attributes of the runtime."
from = ${str(`env:${RUNTIME_RESOURCE_ATTRIBUTES_ENV}`)}
default = ${str(`service.name=${runtime.name}`)}${
        tracesToRuntimeLogGroup(boxVersion)
          ? `

# The runtime's own log group and the log stream of its spans, for the default X-Ray target. The
# Runtime names both in ${RUNTIME_TRACES_HEADERS_ENV}.
[inputs.runtime.traces_log_group]
description = "The runtime's own CloudWatch Logs log group, for its spans."
from = ${str(`env:${RUNTIME_TRACES_HEADERS_ENV}`)}
key = "x-aws-log-group"

[inputs.runtime.traces_log_stream]
description = "The log stream of the runtime's spans."
from = ${str(`env:${RUNTIME_TRACES_HEADERS_ENV}`)}
key = "x-aws-log-stream"`
          : ""
      }`
    : "";
  const gatewayInputs = gateways
    .map((gateway) => {
      const inputs = projectGatewayInputs(gateway);
      return `

# The '${gateway.name}' gateway of the project, which the agent calls through the Box gateway.
[inputs.${inputs.url}]
description = ${str(`The deployed '${gateway.name}' gateway URL.`)}
from = ${str(`env:${gateway.variablePrefix}_URL`)}
pattern = ${str(PROJECT_GATEWAY_URL_PATTERN)}

[inputs.${inputs.host}]
description = ${str(`The deployed '${gateway.name}' gateway host.`)}
from = ${str(`env:${gateway.variablePrefix}_HOST`)}
pattern = ${str(PROJECT_GATEWAY_HOST_PATTERN)}`;
    })
    .join("");
  const gatewayEnv = gateways
    .map(
      (gateway) =>
        `${gateway.variablePrefix}_URL = ${str(`\${{ inputs.${projectGatewayInputs(gateway).url} }}`)}`,
    )
    .join("\n");
  const env = [memoryEnv, otelEnv, gatewayEnv].filter((lines) => lines !== "").join("\n");
  const agentEnv = env ? `\n[agent.env]\n${env}\n` : "";
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
key = "x-aws-log-stream"

# The URL an A2A agent card advertises. Outside a box, serve_a2a reads AGENTCORE_RUNTIME_URL itself
# and otherwise names the contract port; the agent in the box gets the same value through this.
[inputs.runtime.url]
description = "The URL an A2A agent card advertises on the Runtime."
from = "env:AGENTCORE_RUNTIME_URL"
default = "http://localhost:9000/"${memoryInputs}${otelInput}${gatewayInputs}
${agentEnv}`;
}

/**
 * The `@box/agentcore-codezip` pack a CodeZip Runtime profile adds: the Runtime's Python interpreter
 * and its standard library, and the read-only code directory, which only the microVM knows.
 * start.py exports them ({@link BOX_PYTHON_ENV}, {@link BOX_PYTHON_STDLIB_ENV},
 * {@link BOX_CODE_ENV}) before it runs box, and the profile reads them through these inputs, so no
 * start script fills the profile in. box finds the pack beside its binary at
 * {@link AGENTCORE_CODEZIP_PACK_PATH}.
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

[inputs.python.stdlib]
description = "The Python interpreter's standard library, with its native modules."
from = ${str(`env:${BOX_PYTHON_STDLIB_ENV}`)}
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
