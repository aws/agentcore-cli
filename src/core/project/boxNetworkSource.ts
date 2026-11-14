/**
 * Reads the box profile and its policy files once, as Box reads them, runs the profile and policy
 * parsers on them, and builds the Box network model of each runtime that runs its agent in a box.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { boxGatewayName, isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { ProjectStateError } from "../../errors/errors";
import { runsAgentInBox, type PolicyFileCopy } from "./backends/boxContainer";
import { addBoxGatewayTargets, BOX_BEDROCK_POLICY_FILE, BOX_MEMORY_POLICY_FILE } from "./boxMemory";
import {
  BOX_PROFILE_PATH,
  buildBoxNetwork,
  parsePolicyFiles,
  parseProfile,
  type BoxNetwork,
  type BoxNetworkFailure,
  type ParsedProfile,
  type PolicyFileText,
} from "./boxNetwork";

const NO_PROFILE: ParsedProfile = { egress: {}, mcp: {}, policyFiles: [] };

/** The Box network model of each runtime of `spec` that runs its agent in a box. */
export function readBoxNetworks(spec: ProjectSpec, projectRoot: string): BoxNetwork[] {
  const runtimes = isBoxProject(spec)
    ? spec.runtimes.filter((runtime) => runsAgentInBox(projectRoot, runtime))
    : [];
  if (runtimes.length === 0) return [];
  const read = readProfile(projectRoot);
  const files = readPolicyFiles(projectRoot, read.profile.policyFiles);
  const { parsed, failures } = parsePolicyFiles(read.profile, files.texts);
  const found = [...read.failures, ...files.failures, ...failures];
  // The model sees the targets build adds for the model and Memory calls, so no host takes a
  // second target for their endpoints.
  const withDefaults = structuredClone(spec);
  addBoxGatewayTargets(withDefaults, projectRoot);
  return runtimes.map((runtime) => {
    const gateway = boxGatewayName(runtime.name);
    const entry = withDefaults.agentCoreGateways.find(({ name }) => name === gateway);
    const granted = grantedActions(projectRoot, gateway, entry?.additionalPolicies ?? []);
    const network = buildBoxNetwork(parsed, found, {
      spec,
      runtime,
      gateway,
      targets: entry?.targets ?? [],
      grantedActions: granted.actions,
    });
    return { ...network, warnings: [...network.warnings, ...granted.warnings] };
  });
}

/**
 * Each policy file the box profile names, as an image's `.box-dist/` takes it under `agentcore
 * dev`, which stages the profile itself and not the Runtime one, and builds no model. Throws, with
 * every failure where it is, for a profile whose policy files cannot be read and for a policy file
 * Box would refuse.
 */
export function boxPolicyFileCopies(projectRoot: string): PolicyFileCopy[] {
  const { profile, failures: profileFailures } = readProfile(projectRoot);
  const files = readPolicyFiles(projectRoot, profile.policyFiles);
  // The box in the image reads every pack; only build refuses one it does not convert.
  const failures = [
    ...profileFailures.filter(({ code }) => code !== "UNSUPPORTED_PACK"),
    ...files.failures,
  ];
  if (failures.length > 0) {
    const count = `${failures.length} ${failures.length === 1 ? "failure" : "failures"}`;
    throw new ProjectStateError(
      `\`agentcore dev\` cannot stage the policy files of ${BOX_PROFILE_PATH} (${count}):\n` +
        failures.map((failure) => `  - ${failureLine(failure)}`).join("\n") +
        "\n\nNothing was staged. Change the profile or its policy files, then retry.",
    );
  }
  return profile.policyFiles.map((relative) => ({
    from: join(projectRoot, ".box", ...relative.split("/")),
    relative,
  }));
}

/** The box profile of the project, or an empty one when it has none. */
function readProfile(projectRoot: string): {
  profile: ParsedProfile;
  failures: readonly BoxNetworkFailure[];
} {
  const path = join(projectRoot, ...BOX_PROFILE_PATH.split("/"));
  if (!existsSync(path)) return { profile: NO_PROFILE, failures: [] };
  return parseProfile(readFileSync(path, "utf8"));
}

/**
 * Each policy file the profile names, read as Box reads it: a regular file with one link, inside
 * `.box/`, and a failure for each other one.
 */
function readPolicyFiles(
  projectRoot: string,
  files: readonly string[],
): { texts: PolicyFileText[]; failures: BoxNetworkFailure[] } {
  const folder = join(projectRoot, ".box");
  const texts: PolicyFileText[] = [];
  const failures: BoxNetworkFailure[] = [];
  for (const file of files) {
    const place = `.box/${file}`;
    const problem =
      policyPathProblem(file) ?? policyFileProblem(folder, join(folder, ...file.split("/")));
    if (problem !== undefined) {
      failures.push({
        code: "INVALID_POLICY_FILE",
        reason: `${BOX_PROFILE_PATH} names the policy file ${place}, which ${problem}`,
        place,
      });
      continue;
    }
    texts.push({ file: place, text: readFileSync(join(folder, ...file.split("/")), "utf8") });
  }
  return { texts, failures };
}

/** What `.box-dist/` and the image's `/opt/box/` hold for box itself, which no policy file takes. */
const BOX_DIST_NAMES: ReadonlySet<string> = new Set([
  "box",
  "strands-box-sock-alias",
  "strands-box-contain-trampoline",
  "resources",
  "ffi",
  "profile.toml",
  "start.sh",
]);

/** Why start.sh cannot copy a policy file at `file` beside the Runtime profile, if it cannot. */
function policyPathProblem(file: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file)) {
    return "has a character other than a letter, a digit, '.', '_', '-', and '/' in its path, which the AgentCore Runtime start.sh cannot copy";
  }
  const first = file.split("/")[0]!;
  if (BOX_DIST_NAMES.has(first)) {
    return `takes the name ${first}, which box keeps beside its AgentCore Runtime profile`;
  }
  return undefined;
}

/** Why Box would refuse the policy file at `path`, or `undefined` when it reads it. */
function policyFileProblem(folder: string, path: string): string | undefined {
  if (!existsSync(path)) return "does not exist";
  const inside = relative(realpathSync(folder), realpathSync(path));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return "is a symlink that leaves .box/";
  }
  const stat = statSync(path);
  if (stat.isDirectory()) return "is a directory";
  if (!stat.isFile()) return "is not a regular file";
  if (stat.nlink > 1) return `has ${stat.nlink} hard links, and Box reads a policy file with one`;
  return undefined;
}

/** The policy files that build writes for the gateway's role, after it reads them. */
const BUILD_POLICY_FILES: ReadonlySet<string> = new Set([
  BOX_BEDROCK_POLICY_FILE,
  BOX_MEMORY_POLICY_FILE,
]);

/**
 * The actions that the Allow statements of the `.json` policy files of `policies` grant, and a
 * warning for each such file that does not exist, cannot be read, or is not a JSON object, whose
 * actions build then does not count. A policy file that build writes itself may not exist yet.
 */
function grantedActions(
  projectRoot: string,
  gateway: string,
  policies: readonly string[],
): { actions: string[]; warnings: string[] } {
  const actions: string[] = [];
  const warnings: string[] = [];
  for (const policy of policies) {
    if (!policy.endsWith(".json")) continue;
    const skipped = (why: string) =>
      warnings.push(
        `${policy}, which additionalPolicies of gateway '${gateway}' lists, ${why}, so build ` +
          "counts none of its actions when it checks what the gateway's role may sign for",
      );
    let text: string;
    try {
      text = readFileSync(join(projectRoot, ...policy.split("/")), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (!BUILD_POLICY_FILES.has(policy)) skipped("does not exist");
      } else {
        skipped(`cannot be read (${code ?? String(error)})`);
      }
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      skipped(`is not valid JSON (${(error as Error).message})`);
      continue;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      skipped("is not a JSON object");
      continue;
    }
    const { Statement } = document as { Statement?: unknown };
    const statements = Array.isArray(Statement) ? Statement : [Statement];
    for (const statement of statements as { Effect?: unknown; Action?: unknown }[]) {
      if (statement?.Effect !== "Allow") continue;
      const named = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      actions.push(...named.filter((action): action is string => typeof action === "string"));
    }
  }
  return { actions, warnings };
}

/** One failure: its code, its rule, entry, or target, its place, and why. */
function failureLine(failure: BoxNetworkFailure): string {
  const what =
    failure.ruleId !== undefined
      ? `rule ${JSON.stringify(failure.ruleId)}`
      : failure.egressEntry !== undefined
        ? `[egress.${failure.egressEntry}]`
        : failure.mcpEntry !== undefined
          ? `[mcp.${failure.mcpEntry}]`
          : failure.target !== undefined
            ? `target '${failure.target}'`
            : undefined;
  const entry = failure.egressEntry ?? failure.mcpEntry;
  const prefix = `[${failure.egressEntry !== undefined ? "egress" : "mcp"}.${entry}]: `;
  const reason =
    entry !== undefined && failure.reason.startsWith(prefix)
      ? failure.reason.slice(prefix.length)
      : failure.reason;
  const place = failure.place && `at ${failure.place}`;
  return `${[failure.code, what, place].filter(Boolean).join(", ")}: ${reason}`;
}

/**
 * The error text for the models that have failures, with every failure of each. Models whose
 * failures are the same share one block.
 */
export function boxNetworkFailureMessage(networks: readonly BoxNetwork[]): string {
  const groups = new Map<string, BoxNetwork[]>();
  for (const network of networks) {
    if (network.failures.length === 0) continue;
    const lines = network.failures.map((failure) => `  - ${failureLine(failure)}`).join("\n");
    groups.set(lines, [...(groups.get(lines) ?? []), network]);
  }
  const blocks = [...groups].map(([lines, group]) => {
    const count = lines.split("\n").length;
    const gateways = group.map(({ gateway }) => `'${gateway}'`).join(", ");
    const runtimes = group.map(({ runtime }) => `'${runtime}'`).join(", ");
    return (
      `${BOX_PROFILE_PATH} does not parse into the Box network of the Box gateway ` +
      `${gateways} of ${group.length === 1 ? "runtime" : "runtimes"} ${runtimes} ` +
      `(${count} ${count === 1 ? "failure" : "failures"}):\n${lines}`
    );
  });
  return (
    `${blocks.join("\n\n")}\n\nNothing of the box profile was written: no gateway target, ` +
    "credential, Memory target, or file. Change the profile or its policy files, then retry."
  );
}
