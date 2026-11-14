/**
 * Reads the box profile and its policy files once, as Box reads them, runs the profile and policy
 * parsers on them, and builds the Box network model of each runtime that runs its agent in a box.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { boxGatewayName, isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { runsAgentInBox } from "./backends/boxContainer";
import { addBoxGatewayTargets } from "./boxMemory";
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
    return buildBoxNetwork(parsed, found, {
      spec,
      runtime,
      gateway,
      targets: entry?.targets ?? [],
      grantedActions: grantedActions(projectRoot, entry?.additionalPolicies ?? []),
    });
  });
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
    const problem = policyFileProblem(folder, join(folder, ...file.split("/")));
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

/** The actions that the Allow statements of the `.json` policy files of `policies` grant. */
function grantedActions(projectRoot: string, policies: readonly string[]): string[] {
  const actions: string[] = [];
  for (const policy of policies) {
    if (!policy.endsWith(".json")) continue;
    const path = join(projectRoot, ...policy.split("/"));
    if (!existsSync(path)) continue;
    let document: { Statement?: unknown };
    try {
      document = JSON.parse(readFileSync(path, "utf8")) as { Statement?: unknown };
    } catch {
      continue;
    }
    const statements = Array.isArray(document.Statement)
      ? document.Statement
      : [document.Statement];
    for (const statement of statements as { Effect?: unknown; Action?: unknown }[]) {
      if (statement?.Effect !== "Allow") continue;
      const named = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      actions.push(...named.filter((action): action is string => typeof action === "string"));
    }
  }
  return actions;
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
