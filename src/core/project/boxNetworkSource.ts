/**
 * Reads Box's own resolution of the box profile, and the profile's policy files once, as Box reads
 * them, runs the profile and policy parsers on them, and builds the Box network model of each
 * runtime that runs its agent in a box.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { runsAgentInBox } from "./backends/boxContainer";
import { addBoxMemoryTarget, BOX_MEMORY_POLICY_FILE } from "./boxMemory";
import { BOX_PROFILE_FILE, boxProfilePath } from "./templates/boxProfile";
import {
  boxGatewayOf,
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

/** The folder of the box profile, which holds its policy files. */
const BOX_PROFILE_DIR = ".box";

const NO_POLICY: ParsedPolicy = {
  profile: { path: BOX_PROFILE_FILE, egress: {}, mcp: {}, policyFiles: [] },
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
  const { parsed, failures: found } = await readResolvedPolicy(projectRoot, resolver);
  // The model sees the target build adds for the Memory calls, so no host takes a second target
  // for its endpoint.
  const withDefaults = structuredClone(spec);
  addBoxMemoryTarget(withDefaults, projectRoot);
  return runtimes.flatMap((runtime) => {
    // ProjectSpecSchema requires a Box project to keep a gateway bound to each runtime.
    const entry = boxGatewayOf(withDefaults, runtime.name);
    if (!entry) return [];
    const granted = grantedActions(projectRoot, entry.name, entry.additionalPolicies ?? []);
    const network = buildBoxNetwork(parsed, found, {
      spec,
      runtime,
      gateway: entry.name,
      targets: entry.targets,
      grantedActions: granted.actions,
    });
    return [{ ...network, warnings: [...network.warnings, ...granted.warnings] }];
  });
}

/**
 * Box's resolution of the box profile, parsed, with the profile's own policy files to place its
 * rules and to stage; nothing when the project has no profile.
 */
async function readResolvedPolicy(
  projectRoot: string,
  resolver: BoxProfileResolver,
): Promise<{ parsed: ParsedPolicy; failures: readonly BoxNetworkFailure[] }> {
  const text = profileText(projectRoot);
  if (text === undefined) return { parsed: NO_POLICY, failures: [] };
  const named = profilePolicyFiles(text, BOX_PROFILE_FILE);
  const places = profilePlaces(text, BOX_PROFILE_FILE);
  const files = readPolicyFiles(projectRoot, named.ok ? named.files : [], places.policies);
  const resolved = await resolver.resolve(projectRoot, BOX_PROFILE_FILE);
  const profile = parseResolvedProfile(resolved, named.ok ? named.files : [], BOX_PROFILE_FILE);
  const policy = parseResolvedPolicy({ ...profile.profile, places }, resolved.policy, files.texts);
  return {
    parsed: policy.parsed,
    failures: [
      ...(named.ok ? [] : [named.failure]),
      ...profile.failures,
      ...files.failures,
      ...policy.failures,
    ],
  };
}

/** The text of the box profile, or `undefined` when the project has none. */
function profileText(projectRoot: string): string | undefined {
  const path = boxProfilePath(projectRoot);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Each policy file the profile names, read as Box reads it: a regular file with one link, inside
 * `.box/`, and a failure for each other one, at `policies`, the place the profile names it.
 */
function readPolicyFiles(
  projectRoot: string,
  files: readonly string[],
  policies: string = BOX_PROFILE_FILE,
): { texts: PolicyFileText[]; failures: BoxNetworkFailure[] } {
  const folder = join(projectRoot, BOX_PROFILE_DIR);
  const texts: PolicyFileText[] = [];
  const failures: BoxNetworkFailure[] = [];
  for (const file of files) {
    const shown = `${BOX_PROFILE_DIR}/${file}`;
    const problem =
      policyPathProblem(file, shown) ??
      policyFileProblem(folder, join(folder, ...file.split("/")), file, shown);
    if (problem !== undefined) {
      failures.push({ code: "INVALID_POLICY_FILE", reason: problem, place: policies });
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
    return `${shown} is a symbolic link to a file outside ${BOX_PROFILE_DIR}/, which Box does not read. Put the policy file itself in ${BOX_PROFILE_DIR}/.`;
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

/**
 * The actions that the Allow statements of the `.json` policy files of `policies` grant, and a
 * warning for each such file that does not exist, cannot be read, or is not a JSON object, whose
 * actions build then does not count. The Memory policy file that build writes may not exist yet.
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
        if (policy !== BOX_MEMORY_POLICY_FILE) {
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
  return `${failure.place ?? BOX_PROFILE_FILE}  ${failure.reason}`;
}

/**
 * The lines of `failures`, each once, in order of file, line, and column, as a compiler lists
 * them; failures at one place keep their order.
 */
function failureLines(failures: readonly BoxNetworkFailure[]): string[] {
  const key = (failure: BoxNetworkFailure) => {
    const place = failure.place ?? BOX_PROFILE_FILE;
    const [, file = place, line = "0", column = "0"] = /^(.*?):(\d+):(\d+)$/.exec(place) ?? [];
    return { file, line: Number(line), column: Number(column) };
  };
  const sorted = failures
    .map((failure) => ({ failure, at: key(failure) }))
    .sort(
      (a, b) =>
        (a.at.file < b.at.file ? -1 : a.at.file > b.at.file ? 1 : 0) ||
        a.at.line - b.at.line ||
        a.at.column - b.at.column,
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
