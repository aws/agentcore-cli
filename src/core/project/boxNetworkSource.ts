/**
 * Reads Box's own resolution of each boxed agent's local box profile, and the profile's policy
 * files, as Box reads them, runs the profile and policy parsers on them, and builds the Box network
 * model of each runtime that runs its agent in a box.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { boxGatewayName, isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { InvalidEnvironmentError, ProjectStateError } from "../../errors/errors";
import { runsAgentInBox, type PolicyFileCopy } from "./backends/boxContainer";
import { BOX_GATEWAY_BEDROCK_REGION } from "../../handlers/project/shortcuts";
import { addBoxGatewayTargets, BOX_BEDROCK_POLICY_FILE, BOX_MEMORY_POLICY_FILE } from "./boxMemory";
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
import type { BoxProfileResolver, ResolvedBoxProfile } from "./boxProfileResolver";

/** The policy of an agent that has no local box profile at `profilePath`. */
const noPolicy = (profilePath: string): ParsedPolicy => ({
  profile: { path: profilePath, egress: {}, mcp: {}, policyFiles: [] },
  statements: [],
  places: new Map(),
});

/**
 * The Box network model of each runtime of `spec` that runs its agent in a box, from the agent's
 * own local box profile as `resolver` resolves it for a build in `region`. A project with no box
 * runtime resolves nothing, and an agent with no local box profile resolves no profile.
 */
export async function readBoxNetworks(
  spec: ProjectSpec,
  projectRoot: string,
  resolver: BoxProfileResolver,
  region: string = BOX_GATEWAY_BEDROCK_REGION,
  secretsManager = false,
): Promise<BoxNetwork[]> {
  const runtimes = isBoxProject(spec)
    ? spec.runtimes.filter((runtime) => runsAgentInBox(projectRoot, runtime))
    : [];
  if (runtimes.length === 0) return [];
  // The model sees the targets build adds for the model and Memory calls, so no host takes a
  // second target for their endpoints.
  const withDefaults = structuredClone(spec);
  addBoxGatewayTargets(withDefaults, projectRoot, region);
  const networks: BoxNetwork[] = [];
  for (const runtime of runtimes) {
    // Each boxed agent reads its own .box/<name>/local profile and policy files.
    const { parsed, failures: found } = await readResolvedPolicy(
      projectRoot,
      runtime.name,
      resolver,
      region,
    );
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
      secretsManager,
    });
    networks.push({ ...network, warnings: [...network.warnings, ...granted.warnings] });
  }
  return networks;
}

/**
 * Each policy file the local box profile of `agentName` names, as an image's `.box-dist/` takes it
 * under `agentcore dev`, which stages the profile itself and not the Runtime one, runs no box
 * here, and builds no model. Throws, with every failure where it is, for a profile whose policy
 * files cannot be read and for a policy file Box would refuse.
 */
export function boxPolicyFileCopies(projectRoot: string, agentName: string): PolicyFileCopy[] {
  const profileFile = boxLocalProfileFile(agentName);
  const text = profileText(projectRoot, agentName);
  const named =
    text === undefined ? { ok: true as const, files: [] } : profilePolicyFiles(text, profileFile);
  const policies = text === undefined ? undefined : profilePlaces(text, profileFile).policies;
  const files = readPolicyFiles(projectRoot, agentName, named.ok ? named.files : [], policies);
  const failures = [...(named.ok ? [] : [named.failure]), ...files.failures];
  if (failures.length > 0) {
    const lines = failureLines(failures, profileFile);
    throw new ProjectStateError(
      [stoppedHeader("dev", lines.length, failures), ...lines].join("\n"),
    );
  }
  return (named.ok ? named.files : []).map((relative) => ({
    from: join(projectRoot, ...boxLocalDir(agentName).split("/"), ...relative.split("/")),
    relative,
  }));
}

/**
 * Box's resolution of the local box profile of `agentName` for a build in `region`, parsed, with
 * the profile's own policy files to place its rules and to stage; nothing when the agent has no
 * local box profile.
 */
async function readResolvedPolicy(
  projectRoot: string,
  agentName: string,
  resolver: BoxProfileResolver,
  region: string,
): Promise<{ parsed: ParsedPolicy; failures: readonly BoxNetworkFailure[] }> {
  const profileFile = boxLocalProfileFile(agentName);
  const text = profileText(projectRoot, agentName);
  if (text === undefined) return { parsed: noPolicy(profileFile), failures: [] };
  const named = profilePolicyFiles(text, profileFile);
  const places = profilePlaces(text, profileFile);
  const files = readPolicyFiles(
    projectRoot,
    agentName,
    named.ok ? named.files : [],
    places.policies,
  );
  // The Runtime profile sets `[options] bedrock.region` to the region build builds for, so Box
  // resolves box/bedrock's route for that region, not the one `agentcore dev` uses. A profile with
  // a failure of its own stops build either way, so Box resolves it as it is.
  const forRegion =
    named.ok && files.failures.length === 0 ? profileForRegion(text, region) : undefined;
  const resolved =
    forRegion === undefined
      ? await resolver.resolve(projectRoot, profileFile)
      : await resolveCopy(projectRoot, agentName, resolver, forRegion, files.texts);
  const profile = parseResolvedProfile(resolved, named.ok ? named.files : [], profileFile);
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

/** The text of the local box profile of `agentName`, or `undefined` when the agent has none. */
function profileText(projectRoot: string, agentName: string): string | undefined {
  const path = boxLocalProfilePath(projectRoot, agentName);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The pack whose `[options] bedrock.region` the AgentCore Runtime profile sets. */
const BOX_BEDROCK_PACK = "box/bedrock";

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `[options] bedrock.region` of the profile `table`, as a dotted or a quoted key. */
function bedrockRegionOf(table: Record<string, unknown>): unknown {
  const options = isTable(table.options) ? table.options : {};
  return isTable(options.bedrock) && options.bedrock.region !== undefined
    ? options.bedrock.region
    : options["bedrock.region"];
}

/**
 * The box profile `text` with `[options] bedrock.region` set to `region`, as the AgentCore Runtime
 * profile sets it, or `undefined` when the profile imports no box/bedrock or already has that
 * region. An edit of the line that sets the region keeps every other line where it is.
 */
function profileForRegion(text: string, region: string): string | undefined {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const packs = Array.isArray(table.packs) ? table.packs : [];
  if (!packs.includes(BOX_BEDROCK_PACK) || bedrockRegionOf(table) === region) return undefined;
  const line =
    /^(\s*(?:bedrock\s*\.\s*region|"bedrock\.region"|'bedrock\.region')\s*=\s*)(?:"[^"\n]*"|'[^'\n]*')/m;
  const edited = text.replace(line, (_, key: string) => `${key}${JSON.stringify(region)}`);
  try {
    if (edited !== text && bedrockRegionOf(parseToml(edited)) === region) return edited;
  } catch {
    // The edit set another key, or broke the TOML, so the copy is written from the table.
  }
  const { "bedrock.region": _quoted, ...options } = isTable(table.options) ? table.options : {};
  const bedrock = isTable(options.bedrock) ? options.bedrock : {};
  return stringifyToml({ ...table, options: { ...options, bedrock: { ...bedrock, region } } });
}

/**
 * Box's resolution of the local box profile `text` of `agentName`, from a copy in a temporary
 * folder beside a copy of each policy file of `policies`. Box's errors name the profile and its
 * folder, not the copy.
 */
async function resolveCopy(
  projectRoot: string,
  agentName: string,
  resolver: BoxProfileResolver,
  text: string,
  policies: readonly PolicyFileText[],
): Promise<ResolvedBoxProfile> {
  const localDir = boxLocalDir(agentName);
  const folder = realpathSync(await mkdtemp(join(tmpdir(), "agentcore-box-profile-")));
  const copy = join(folder, "profile.toml");
  try {
    await writeFile(copy, text);
    for (const policy of policies) {
      const to = join(folder, ...policy.file.slice(`${localDir}/`.length).split("/"));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, policy.text);
    }
    return await resolver.resolve(projectRoot, copy);
  } catch (error) {
    if (!(error instanceof InvalidEnvironmentError)) throw error;
    throw new InvalidEnvironmentError(
      error.message
        .replaceAll(copy, boxLocalProfileFile(agentName))
        .replaceAll(folder, join(projectRoot, ...localDir.split("/"))),
      { cause: error },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Each policy file the local box profile of `agentName` names, read as Box reads it: a regular
 * file with one link, inside `.box/<name>/local/`, and a failure for each other one, at `policies`,
 * the place the profile names it.
 */
function readPolicyFiles(
  projectRoot: string,
  agentName: string,
  files: readonly string[],
  policies: string = boxLocalProfileFile(agentName),
): { texts: PolicyFileText[]; failures: BoxNetworkFailure[] } {
  const localDir = boxLocalDir(agentName);
  const folder = join(projectRoot, ...localDir.split("/"));
  const texts: PolicyFileText[] = [];
  const failures: BoxNetworkFailure[] = [];
  for (const file of files) {
    const shown = `${localDir}/${file}`;
    const problem =
      policyPathProblem(file, shown) ??
      policyFileProblem(folder, join(folder, ...file.split("/")), file, shown, localDir);
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

/**
 * Why Box would refuse the policy file at `path`, inside `folder`, which is `localDir` from the
 * project root, or `undefined` when it reads it.
 */
function policyFileProblem(
  folder: string,
  path: string,
  file: string,
  shown: string,
  localDir: string,
): string | undefined {
  if (!existsSync(path)) {
    return `\`policies\` names ${file}, but ${shown} does not exist. Create it, or remove it from \`policies\`.`;
  }
  const inside = relative(realpathSync(folder), realpathSync(path));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return `${shown} is a symbolic link to a file outside ${localDir}/, which Box does not read. Put the policy file itself in ${localDir}/.`;
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

/** The policy files that build writes for the gateway's role. */
const BUILD_POLICY_FILES: ReadonlySet<string> = new Set([
  BOX_BEDROCK_POLICY_FILE,
  BOX_MEMORY_POLICY_FILE,
]);

/**
 * The actions that the Allow statements of the `.json` policy files of `policies` grant, and a
 * warning for each such file that does not exist, cannot be read, or is not a JSON object, whose
 * actions build then does not count. The policy files that build writes are not read: each one
 * counts for its own endpoint when it is listed (`boxGatewayIamWarnings`).
 */
function grantedActions(
  projectRoot: string,
  gateway: string,
  policies: readonly string[],
): { actions: string[]; warnings: string[] } {
  const actions: string[] = [];
  const warnings: string[] = [];
  for (const policy of policies) {
    if (!policy.endsWith(".json") || BUILD_POLICY_FILES.has(policy)) continue;
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
        skipped("does not exist", "Create it, or remove it from additionalPolicies.");
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

/**
 * One problem: where it is, or `profileFile` when it has no place, then what is wrong and how to
 * fix it.
 */
function failureLine(failure: BoxNetworkFailure, profileFile: string): string {
  return `${failure.place ?? profileFile}  ${failure.reason}`;
}

/**
 * The lines of `failures` of the box profile `profileFile`, each once, in order of file, line, and
 * column, as a compiler lists them; failures at one place keep their order.
 */
function failureLines(failures: readonly BoxNetworkFailure[], profileFile: string): string[] {
  const key = (failure: BoxNetworkFailure) => {
    const place = failure.place ?? profileFile;
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
  return unique(sorted.map(({ failure }) => failureLine(failure, profileFile)));
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
  const lines = networks.map((network) =>
    failureLines(network.failures, boxLocalProfileFile(network.runtime)),
  );
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
