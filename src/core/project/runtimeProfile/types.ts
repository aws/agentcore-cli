/**
 * The shared types of the AgentCore Runtime box profile that build derives from a runtime's local
 * box profile. The local profile goes in as a TOML table. Each rule changes only what must be
 * different on AgentCore Runtime, and keeps every other key. A problem stops build.
 */
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { BoxNetworkHost, CloudWatchTelemetry } from "../boxNetwork";

/** A TOML table as smol-toml parses it: a key holds a string, a number, a boolean, a list, or a table. */
export type TomlTable = Record<string, unknown>;

/** The inputs that the generated packs fill in on AgentCore Runtime, as a profile names them. */
export const RUNTIME_INPUTS = {
  /** The runtime's Box gateway URL (box/agentcore). */
  gatewayUrl: "${{ inputs.gateway.url }}",
  /** The Runtime's region (box/agentcore). */
  awsRegion: "${{ inputs.aws.region }}",
  /** The unpacked zip of a CodeZip runtime (box/agentcore-codezip). */
  codeDir: "${{ inputs.code.dir }}",
  /** The Python of a CodeZip Runtime (box/agentcore-codezip). */
  pythonPath: "${{ inputs.python.path }}",
  /** The base prefix of that Python (box/agentcore-codezip). */
  pythonPrefix: "${{ inputs.python.prefix }}",
} as const;

/**
 * Where a path of the local profile is on AgentCore Runtime. A container image runs the same paths
 * under `agentcore dev` and on the Runtime. A CodeZip zip holds only the code folder, and the
 * Runtime runs its own Python.
 */
export interface RuntimePaths {
  readonly build: "CodeZip" | "Container";
  /** The code folder, as the local profile names it: `${{ workspace }}/<codeLocation>`. */
  readonly localCode: string;
  /** The venv of the code folder, as the local profile names it. */
  readonly localVenv: string;
  /** The uv-managed Pythons that the local profile grants: `${{ home }}/.local/share/uv/python`. */
  readonly localPythons: string;
  /** The code folder on the Runtime: `${{ inputs.code.dir }}` (CodeZip), `${{ workspace }}` (image). */
  readonly runtimeCode: string;
  /** The Python on the Runtime, for the venv's Python: `${{ inputs.python.path }}` on CodeZip. */
  readonly runtimePython: string;
  /** The prefix of that Python, for the uv Pythons: `${{ inputs.python.prefix }}` on CodeZip. */
  readonly runtimePythonPrefix: string;
  /** The code folder as a message names it: `app/agent/`. */
  readonly shownCode: string;
}

/** What a rule knows of the runtime besides the local profile. */
export interface RuntimeProfileContext {
  readonly spec: ProjectSpec;
  readonly runtime: ProjectRuntime;
  /** The local profile's path from the project root: `.box/<runtime>/local/profile.toml`. */
  readonly profileFile: string;
  /** The region build builds for: of the Box gateway and its `bedrock` and `agentcore` targets. */
  readonly region: string;
  /** The runtime's Box gateway: its name, and its targets with the ones build adds. */
  readonly gateway: { readonly name: string; readonly targets: readonly AgentCoreGatewayTarget[] };
  /** The hosts of the Box network model, each with the gateway target it gets. */
  readonly hosts: readonly BoxNetworkHost[];
  /** The CloudWatch targets of the local profile, with the deploy region set. */
  readonly telemetry: readonly CloudWatchTelemetry[];
  /** The local profile's policy files, from its folder, which staging copies beside it. */
  readonly policyFiles: readonly string[];
  readonly paths: RuntimePaths;
  /**
   * The profile that `agentcore create` writes for this runtime, `local`, and its Runtime form,
   * `runtime`, with no route: a rule tells the template's own values from the user's by them.
   */
  readonly template: { readonly local: TomlTable; readonly runtime: TomlTable };
  /** Where the local profile sets `key`, as `file:line:column`, or the profile file. */
  readonly placeOf: (key: readonly string[]) => string;
}

/** Why a key of the local profile cannot go to AgentCore Runtime. */
export const RUNTIME_PROFILE_PROBLEM_CODES = [
  /** A path of the project or the home folder that is not on the Runtime. */
  "RUNTIME_PATH_NOT_FOUND",
  /** A program that build cannot find on the Runtime. */
  "RUNTIME_PROGRAM_NOT_FOUND",
  /** A process whose calls on the Runtime would not go through the Box gateway. */
  "RUNTIME_EGRESS_NOT_CONTAINED",
] as const;
export type RuntimeProfileProblemCode = (typeof RUNTIME_PROFILE_PROBLEM_CODES)[number];

/** A key of the local profile that cannot go to AgentCore Runtime: build stops for it. */
export interface RuntimeProfileProblem {
  readonly code: RuntimeProfileProblemCode;
  /** The key in the local profile: `["mcp", "notes", "command"]`. */
  readonly key: readonly string[];
  /** What is wrong and how to fix it, in whole sentences that start with the key. */
  readonly reason: string;
  /** `file:line:column` of the key, or the profile file. */
  readonly place: string;
}

/** What one rule makes of the table it gets. */
export interface RuleResult {
  readonly table: TomlTable;
  readonly problems: readonly RuntimeProfileProblem[];
  readonly warnings: readonly string[];
}

/** One rule of the derivation: it returns a new table, and changes no table it gets. */
export type RuntimeProfileRule = (
  table: Readonly<TomlTable>,
  context: RuntimeProfileContext,
) => RuleResult;
