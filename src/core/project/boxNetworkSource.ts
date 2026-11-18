/**
 * Reads Box's own resolution of the box profile, and the profile's policy files once, as Box reads
 * them, runs the profile and policy parsers on them, and builds the Box network model of each
 * runtime that runs its agent in a box.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { boxGatewayName, isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { ProjectStateError } from "../../errors/errors";
import { runsAgentInBox, type PolicyFileCopy } from "./backends/boxContainer";
import { BOX_GATEWAY_BEDROCK_REGION } from "../../handlers/project/shortcuts";
import { addBoxGatewayTargets } from "./boxMemory";
import { boxLocalDir, boxLocalProfileFile, boxLocalProfilePath } from "./templates/boxProfile";
import {
  buildBoxNetwork,
  parseResolvedPolicy,
  parseResolvedProfile,
  profilePlaces,
  profilePolicyFiles,
  type BoxNetwork,
  type BoxNetworkFailure,
  type ParsedPolicy,
  type PolicyFileText,
} from "./boxNetwork";
import type { BoxProfileResolver } from "./boxProfileResolver";

const NO_POLICY: ParsedPolicy = {
  profile: { egress: {}, mcp: {}, policyFiles: [] },
  statements: [],
  places: new Map(),
};

/**
 * The Box network model of each runtime of `spec` that runs its agent in a box, from the box
 * profile as `resolver` resolves it. A project with no box runtime, or no box profile, resolves
 * nothing.
 */
export async function readBoxNetworks(
  spec: ProjectSpec,
  projectRoot: string,
  resolver: BoxProfileResolver,
): Promise<BoxNetwork[]> {
  const runtimes = isBoxProject(spec)
    ? spec.runtimes.filter((runtime) => runsAgentInBox(projectRoot, runtime))
    : [];
  if (runtimes.length === 0) return [];
  // The model sees the targets build adds for the model and Memory calls, so no host takes a
  // second target for their endpoints.
  const withDefaults = structuredClone(spec);
  addBoxGatewayTargets(withDefaults, projectRoot, region);
  return runtimes.map((runtime) => {
    // Each boxed agent reads its own box/<name>/local profile and policy files. The Runtime
    // profile sets `[options] bedrock.region` to the region build builds for, so the model reads
    // box/bedrock's route for that region, not the one `agentcore dev` uses.
    const read = readProfile(projectRoot, runtime.name, region);
    const files = readPolicyFiles(projectRoot, runtime.name, read.profile.policyFiles);
    const { parsed, failures } = parsePolicyFiles(read.profile, files.texts);
    const found = [...read.failures, ...files.failures, ...failures];
    const gateway = boxGatewayName(runtime.name);
    const entry = withDefaults.agentCoreGateways.find(({ name }) => name === gateway);
    const granted = grantedActions(projectRoot, gateway, entry?.additionalPolicies ?? []);
    const network = buildBoxNetwork(parsed, found, {
      spec,
      runtime,
      gateway,
      region,
      targets: entry?.targets ?? [],
      grantedActions: granted.actions,
    });
    return { ...network, warnings: [...network.warnings, ...granted.warnings] };
  });
}

/**
 * Each policy file the box profile names, as an image's `.box-dist/` takes it under `agentcore
 * dev`, which stages the profile itself and not the Runtime one, runs no box here, and builds no
 * model. Throws, with every failure where it is, for a profile whose policy files cannot be read
 * and for a policy file Box would refuse.
 */
export function boxPolicyFileCopies(projectRoot: string, agentName: string): PolicyFileCopy[] {
  const { profile } = readProfile(projectRoot, agentName);
  const { failures } = readPolicyFiles(projectRoot, agentName, profile.policyFiles);
  if (failures.length > 0) {
    const lines = failureLines(failures);
    throw new ProjectStateError(
      [stoppedHeader("dev", lines.length, failures), ...lines].join("\n"),
    );
  }
  return profile.policyFiles.map((relative) => ({
    from: join(projectRoot, ...boxLocalDir(agentName).split("/"), ...relative.split("/")),
    relative,
  }));
}

/** The local box profile of the agent, or an empty one when it has none. */
function readProfile(
  projectRoot: string,
  agentName: string,
  bedrockRegion?: string,
): {
  profile: ParsedProfile;
  failures: readonly BoxNetworkFailure[];
} {
  const path = boxLocalProfilePath(projectRoot, agentName);
  if (!existsSync(path)) return { profile: NO_PROFILE, failures: [] };
  return parseProfile(readFileSync(path, "utf8"), boxLocalProfileFile(agentName), bedrockRegion);
}

/**
 * Each policy file the profile names, read as Box reads it: a regular file with one link, inside
 * the agent's `box/<name>/local/` folder, and a failure for each other one.
 */
function readPolicyFiles(
  projectRoot: string,
  agentName: string,
  files: readonly string[],
  policies: string = BOX_PROFILE_PATH,
): { texts: PolicyFileText[]; failures: BoxNetworkFailure[] } {
  const localDir = boxLocalDir(agentName);
  const folder = join(projectRoot, ...localDir.split("/"));
  const texts: PolicyFileText[] = [];
  const failures: BoxNetworkFailure[] = [];
  for (const file of files) {
    const place = `${localDir}/${file}`;
    const problem =
      policyPathProblem(file, shown) ??
      policyFileProblem(folder, join(folder, ...file.split("/")), file, shown);
    if (problem !== undefined) {
      failures.push({
        code: "INVALID_POLICY_FILE",
        reason: `${boxLocalProfileFile(agentName)} names the policy file ${place}, which ${problem}`,
        place,
      });
      continue;
    }
    texts.push({ file: shown, text: readFileSync(join(folder, ...file.split("/")), "utf8") });
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

/**
 * Why the Runtime cannot take a copy of the policy file `file`, shown as `shown`, beside its
 * profile, if it cannot.
 */
function policyPathProblem(file: string, shown: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file)) {
    return (
      `${shown} has a character other than a letter, a digit, ".", "_", "-", or "/" in its ` +
      "path, and deploy cannot copy it to AgentCore Runtime. Rename the file."
    );
  }
  const first = file.split("/")[0]!;
  if (BOX_DIST_NAMES.has(first)) {
    return (
      `${shown} takes the name "${first}", which Box keeps for its own files on AgentCore ` +
      `Runtime. Rename the ${first === file ? "file" : "folder"}.`
    );
  }
  return undefined;
}

/** Why Box would refuse the policy file at `path`, or `undefined` when it reads it. */
function policyFileProblem(
  folder: string,
  path: string,
  file: string,
  shown: string,
): string | undefined {
  if (!existsSync(path)) {
    return `\`policies\` names ${file}, but ${shown} does not exist. Create it, or remove it from \`policies\`.`;
  }
  const inside = relative(realpathSync(folder), realpathSync(path));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return "is a symlink that leaves the agent's local box folder";
  }
  const stat = statSync(path);
  if (stat.isDirectory())
    return `${shown} is a folder, not a policy file. Name a file in \`policies\`.`;
  if (!stat.isFile()) return `${shown} is not a regular file. Name a policy file in \`policies\`.`;
  if (stat.nlink > 1) {
    return `${shown} has ${stat.nlink} hard links, and Box reads only a policy file with one. Replace it with a copy.`;
  }
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
    const skipped = (why: string, fix: string) =>
      warnings.push(
        `${policy}, in additionalPolicies of the gateway '${gateway}', ${why}, so build cannot ` +
          `check the permissions it grants. ${fix}`,
      );
    let text: string;
    try {
      text = readFileSync(join(projectRoot, ...policy.split("/")), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (!BUILD_POLICY_FILES.has(policy)) {
          skipped("does not exist", "Create it, or remove it from additionalPolicies.");
        }
      } else {
        skipped(
          `cannot be read (${code ?? String(error)})`,
          "Make it readable, or remove it from additionalPolicies.",
        );
      }
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      skipped(`is not valid JSON (${(error as Error).message})`, "Correct the JSON.");
      continue;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      skipped("is not a JSON object", "Make it an IAM policy document.");
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

/** The command that a list of problems stops. */
type BoxNetworkCommand = "build" | "deploy" | "dev";

const STOPPED: Readonly<Record<BoxNetworkCommand, string>> = {
  build: "Build",
  deploy: "Deploy",
  dev: "Dev",
};

/** One problem: where it is, then what is wrong and how to fix it. */
function failureLine(failure: BoxNetworkFailure): string {
  return `${failure.place ?? BOX_PROFILE_PATH}  ${failure.reason}`;
}

/**
 * The lines of `failures`, each once, in order of file, line, and column, as a compiler lists
 * them; failures at one place keep their order.
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
    const profiles = group.map(({ runtime }) => boxLocalProfileFile(runtime)).join(", ");
    return (
      `${profiles} ${group.length === 1 ? "does" : "do"} not parse into the Box network of the ` +
      `Box gateway ${gateways} of ${group.length === 1 ? "runtime" : "runtimes"} ${runtimes} ` +
      `(${count} ${count === 1 ? "failure" : "failures"}):\n${lines}`
    );
  return unique(sorted.map(({ failure }) => failureLine(failure)));
}

/** `Build stopped: 2 problems in the Box profile. Nothing was changed.` */
function stoppedHeader(
  command: BoxNetworkCommand,
  count: number,
  failures: readonly BoxNetworkFailure[],
): string {
  const inSpec = (failure: BoxNetworkFailure) => failure.place?.startsWith("agentcore/") === true;
  const where = [
    failures.some((failure) => !inSpec(failure)) && "the Box profile",
    failures.some(inSpec) && "agentcore.json",
  ].filter(Boolean);
  return (
    `${STOPPED[command]} stopped: ${count} ${count === 1 ? "problem" : "problems"} in ` +
    `${where.join(" and ")}. Nothing was changed.`
  );
}

function unique(lines: readonly string[]): string[] {
  return [...new Set(lines)];
}

/**
 * The error text for the models that have failures: a header, then one line for each problem, in
 * order of place. With more than one box runtime, the problems of only some runtimes follow
 * `In runtime <name>:`.
 */
export function boxNetworkFailureMessage(
  networks: readonly BoxNetwork[],
  command: Exclude<BoxNetworkCommand, "dev">,
): string {
  const lines = networks.map((network) => failureLines(network.failures));
  const shared = lines[0]?.filter((line) => lines.every((own) => own.includes(line))) ?? [];
  const blocks: string[] = [];
  let count = shared.length;
  networks.forEach((network, index) => {
    const own = lines[index]!.filter((line) => !shared.includes(line));
    if (own.length === 0) return;
    count += own.length;
    blocks.push(`In runtime ${network.runtime}:`, ...own.map((line) => `  ${line}`));
  });
  const header = stoppedHeader(
    command,
    count,
    networks.flatMap((network) => network.failures),
  );
  return [header, ...shared, ...blocks].join("\n");
}
