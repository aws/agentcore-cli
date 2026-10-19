import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { parse as parseToml, type TomlTableWithoutBigInt } from "smol-toml";
import { ProjectStateError } from "../../errors";
import {
  NodeRuntimeSchema,
  PythonRuntimeSchema,
  type RuntimeVersion,
} from "../../projectSchemas/constants";
import { EntrypointSchema, type ProjectRuntime } from "../../projectSchemas/runtime";

/**
 * Re-derives a runtime's build settings (`build`, `dockerfile`, `runtimeVersion`,
 * `entrypoint`) from its code folder before dev, build, and deploy. The code wins
 * where it states a value (a Dockerfile, requires-python / engines.node,
 * `[tool.agentcore] entrypoint` / package.json `main`); otherwise the value in
 * agentcore.json is kept, which is how a user pins one. The caller writes any
 * changes back to agentcore.json, so synth always sees a complete runtime.
 */

export const DOCKERFILE_NAME = "Dockerfile";

type Language = "Python" | "Node";

type SyncedField = "build" | "dockerfile" | "runtimeVersion" | "entrypoint";

/** One field the code folder changed, and why. `to` undefined means the field is removed. */
export interface RuntimeChange {
  field: SyncedField;
  from?: string;
  to?: string;
  reason: string;
}

export interface RuntimeSync {
  runtime: ProjectRuntime;
  changes: RuntimeChange[];
  warnings: string[];
}

/** `search: runtimeVersion PYTHON_3_14 -> PYTHON_3_12 (requires-python ">=3.10,<3.13" in app/search/pyproject.toml)` */
export function describeChange(name: string, change: RuntimeChange): string {
  const line =
    `${name}: ${change.field} ${change.from ?? "(unset)"} -> ${change.to ?? "(removed)"} ` +
    `(${change.reason})`;
  // Switching to a container changes how the runtime builds and deploys, so say so,
  // and spell out every edit going back takes: the schema rejects a CodeZip runtime
  // that still has a dockerfile or lacks a runtimeVersion, so "build" alone fails.
  return change.field === "build" && change.to === "Container"
    ? `${line}. It now builds and deploys as a container image from that Dockerfile; to go ` +
        `back, delete the Dockerfile, then in agentcore.json set "build": "CodeZip", remove ` +
        `"dockerfile", and add back the "runtimeVersion" removed below.`
    : line;
}

/**
 * The agentcore.json edits that turn a Container runtime back into CodeZip. The
 * schema rejects a CodeZip runtime with container-only fields or no runtimeVersion,
 * and agentcore.json is validated before sync runs, so every edit has to be named.
 */
function codeZipRevertEdits(runtime: ProjectRuntime): string {
  const edits = ['set "build": "CodeZip"'];
  const containerOnly = (["dockerfile", "buildContextPath", "customDockerBuildArgs"] as const)
    .filter((field) => runtime[field] !== undefined)
    .map((field) => `"${field}"`);
  if (containerOnly.length > 0) edits.push(`remove ${containerOnly.join(", ")}`);
  if (runtime.runtimeVersion === undefined) {
    const latest = entrypointLanguage(runtime) === "Python" ? LATEST_PYTHON : LATEST_NODE;
    edits.push(`add "runtimeVersion" (for example "${latest}")`);
  }
  return edits.length <= 2
    ? edits.join(" and ")
    : `${edits.slice(0, -1).join(", ")}, and ${edits[edits.length - 1]}`;
}

/** Re-derives a runtime's build settings. Throws a {@link ProjectStateError} when they cannot be. */
export function syncRuntimeBuild(runtime: ProjectRuntime, projectRoot: string): RuntimeSync {
  const next: ProjectRuntime = { ...runtime };
  const reasons: Partial<Record<SyncedField, string>> = {};
  const warnings: string[] = [];
  const context = contextDir(runtime, projectRoot);
  const contextLabel = displayPath(projectRoot, context);

  // build: a CodeZip runtime becomes Container when a Dockerfile appears in its
  // build context. A Container runtime never flips back on its own: a missing
  // Dockerfile is a precheck error, so deleting one by accident cannot silently
  // change how the runtime deploys.
  if (runtime.build === "CodeZip" && hasDockerfile(context)) {
    next.build = "Container";
    next.dockerfile = DOCKERFILE_NAME;
    reasons.build = reasons.dockerfile = `${DOCKERFILE_NAME} in ${contextLabel}`;
  } else if (runtime.build === "Container" && runtime.dockerfile === undefined) {
    next.dockerfile = DOCKERFILE_NAME;
    reasons.dockerfile = "default";
  }

  // entrypoint, from the manifest for the runtime's language. package.json
  // `main` only names the CodeZip bundle; a Container image decides its own.
  const language = entrypointLanguage(runtime);
  const pyproject = language === "Python" ? readPyproject(runtime, projectRoot) : undefined;
  const entrypoint =
    language === "Python"
      ? pythonEntrypoint(runtime, pyproject)
      : next.build === "CodeZip"
        ? nodeEntrypoint(runtime, projectRoot, warnings)
        : undefined;
  if (entrypoint !== undefined) {
    next.entrypoint = entrypoint.value;
    reasons.entrypoint = entrypoint.reason;
  }

  // runtimeVersion: CodeZip only; a Container image picks its own.
  if (next.build === "Container") {
    delete next.runtimeVersion;
    reasons.runtimeVersion = "Container build";
  } else {
    // requires-python / engines.node is a constraint, not a choice: a version in
    // agentcore.json that satisfies it is kept, so neither a loose range nor a
    // newer CLI with newer runtimes moves a runtime on its own. Only a version
    // the constraint excludes (or none at all) is replaced, with the highest match.
    const allowed =
      language === "Python"
        ? allowedPythonVersions(runtime, pyproject)
        : allowedNodeVersions(runtime, projectRoot);
    if (allowed !== undefined) {
      if (next.runtimeVersion === undefined || !allowed.versions.includes(next.runtimeVersion)) {
        next.runtimeVersion = allowed.versions[0]!;
        reasons.runtimeVersion = allowed.source;
      }
    } else if (next.runtimeVersion === undefined) {
      const latest = language === "Python" ? LATEST_PYTHON : LATEST_NODE;
      next.runtimeVersion = latest;
      reasons.runtimeVersion = "default";
      warnings.push(
        language === "Python"
          ? `runtime "${runtime.name}": no requires-python in pyproject.toml; using ${versionLabel(latest)}. ` +
              `Set requires-python (or runtimeVersion in agentcore.json) to pin a version.`
          : `runtime "${runtime.name}": no engines.node in package.json; using ${versionLabel(latest)}. ` +
              `Set engines.node (or runtimeVersion in agentcore.json) to pin a version.`,
      );
    }
  }

  const changes = (["build", "dockerfile", "runtimeVersion", "entrypoint"] as const)
    .filter((field) => runtime[field] !== next[field])
    .map((field) => ({
      field,
      from: runtime[field],
      to: next[field],
      reason: reasons[field] ?? "agentcore.json",
    }));
  return { runtime: next, changes, warnings };
}

/**
 * Whether `dir` holds a regular file named exactly `Dockerfile`. Listing the
 * directory keeps the match case-sensitive on case-insensitive file systems
 * (macOS, Windows), as the L3 constructs do; statSync follows a symlink.
 */
function hasDockerfile(dir: string): boolean {
  try {
    return readdirSync(dir).includes(DOCKERFILE_NAME) && isFile(join(dir, DOCKERFILE_NAME));
  } catch {
    return false;
  }
}

function entrypointLanguage(runtime: ProjectRuntime): Language {
  const [file = ""] = runtime.entrypoint.split(":");
  if (file.endsWith(".py")) return "Python";
  if (file.endsWith(".ts") || file.endsWith(".js")) return "Node";
  throw new ProjectStateError(
    `runtime "${runtime.name}": cannot tell the language of entrypoint "${runtime.entrypoint}". ` +
      `Use a .py, .ts, or .js entrypoint.`,
  );
}

type ParsedPyproject = {
  file: string;
  toml: TomlTableWithoutBigInt;
};

function readPyproject(runtime: ProjectRuntime, projectRoot: string): ParsedPyproject | undefined {
  const manifest = findManifest("pyproject.toml", runtime, projectRoot);
  if (manifest === undefined) return undefined;
  const file = displayPath(projectRoot, manifest);
  try {
    return {
      file,
      toml: parseToml(readFileSync(manifest, "utf-8"), { integersAsBigInt: false }),
    };
  } catch (error) {
    throw new ProjectStateError(`runtime "${runtime.name}": cannot parse ${file} as TOML.`, {
      cause: error,
    });
  }
}

function tomlValue(toml: TomlTableWithoutBigInt, path: string[]): unknown {
  let current: unknown = toml;
  for (const key of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function displayManifestValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** `tool.agentcore.entrypoint` from pyproject.toml, when set. */
function pythonEntrypoint(
  runtime: ProjectRuntime,
  manifest: ParsedPyproject | undefined,
): { value: string; reason: string } | undefined {
  if (manifest === undefined) return undefined;
  const value = tomlValue(manifest.toml, ["tool", "agentcore", "entrypoint"]);
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !EntrypointSchema.safeParse(value).success ||
    !/\.py(:|$)/.test(value)
  ) {
    throw new ProjectStateError(
      `runtime "${runtime.name}": [tool.agentcore] entrypoint ${displayManifestValue(value)} in ` +
        `${manifest.file} is not a Python file path relative to the runtime folder ` +
        `(for example "main.py" or "main.py:app").`,
    );
  }
  return { value, reason: `[tool.agentcore] entrypoint in ${manifest.file}` };
}

/**
 * package.json `main`, when set. The L3 Node packager always bundles main.ts at
 * the root of the folder, so only main.ts / main.js are accepted, stored as the
 * bundle's name, main.js.
 */
function nodeEntrypoint(
  runtime: ProjectRuntime,
  projectRoot: string,
  warnings: string[],
): { value: string; reason: string } | undefined {
  const manifest = readPackageJson(runtime, projectRoot);
  const main = manifest?.json.main;
  if (main === undefined) return undefined;
  const normalized = typeof main === "string" ? main.replace(/^\.\//, "") : undefined;
  if (normalized !== "main.ts" && normalized !== "main.js") {
    // Many packages set "main" for other reasons (a library build, a start
    // script), so it is ignored with a warning rather than refused.
    warnings.push(
      `runtime "${runtime.name}": package.json "main" is ${JSON.stringify(main)}; AgentCore ` +
        `currently bundles main.ts at the root of ` +
        `${displayPath(projectRoot, resolve(projectRoot, runtime.codeLocation))}, so "main" is ignored.`,
    );
    return undefined;
  }
  return { value: "main.js", reason: `"main" in ${manifest!.file}` };
}

function readPackageJson(
  runtime: ProjectRuntime,
  projectRoot: string,
): { file: string; json: { main?: unknown; engines?: { node?: unknown } } } | undefined {
  const manifest = findManifest("package.json", runtime, projectRoot);
  if (manifest === undefined) return undefined;
  const file = displayPath(projectRoot, manifest);
  try {
    const json: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
    return { file, json: json !== null && typeof json === "object" ? json : {} };
  } catch (error) {
    throw new ProjectStateError(`runtime "${runtime.name}": cannot parse ${file} as JSON.`, {
      cause: error,
    });
  }
}

type AllowedVersions = {
  /** Supported versions the constraint allows, highest first; never empty. */
  versions: RuntimeVersion[];
  /** The constraint and the manifest it is in. */
  source: string;
};

const PYTHON_VERSIONS = PythonRuntimeSchema.options.map((option) => ({
  option,
  minor: Number(option.split("_")[2]),
}));
const NODE_VERSIONS = NodeRuntimeSchema.options.map((option) => ({
  option,
  major: Number(option.split("_")[1]),
}));
export const LATEST_PYTHON = PYTHON_VERSIONS[PYTHON_VERSIONS.length - 1]!.option;
export const LATEST_NODE = NODE_VERSIONS[NODE_VERSIONS.length - 1]!.option;

/** The highest supported Python matching requires-python, or undefined when it is not set. */
function allowedPythonVersions(
  runtime: ProjectRuntime,
  manifest: ParsedPyproject | undefined,
): AllowedVersions | undefined {
  if (manifest === undefined) return undefined;
  const requiresPython = tomlValue(manifest.toml, ["project", "requires-python"]);
  // An empty value says nothing, so it counts as missing.
  if (requiresPython === undefined || requiresPython === "") return undefined;

  const value = requiresPython;
  const clauses = typeof value === "string" ? parseSpecifierSet(value) : undefined;
  if (clauses === undefined) {
    throw new ProjectStateError(
      `runtime "${runtime.name}": cannot parse requires-python ${displayManifestValue(value)} in ` +
        `${manifest.file}. Use a PEP 440 specifier such as ">=3.12", or set runtimeVersion in ` +
        `agentcore.json.`,
    );
  }
  const versions = [...PYTHON_VERSIONS]
    .reverse()
    .filter(({ minor }) => pythonMinorSatisfies(3, minor, clauses))
    .map(({ option }) => option);
  if (versions.length === 0) {
    throw new ProjectStateError(
      `runtime "${runtime.name}": requires-python "${value}" in ${manifest.file} matches no ` +
        `supported Python version (supported: ${PYTHON_VERSIONS.map(({ minor }) => `3.${minor}`).join(", ")}).`,
    );
  }
  return { versions, source: `requires-python "${value}" in ${manifest.file}` };
}

/** The supported Node.js majors engines.node allows, or undefined when it is not set. */
function allowedNodeVersions(
  runtime: ProjectRuntime,
  projectRoot: string,
): AllowedVersions | undefined {
  const manifest = readPackageJson(runtime, projectRoot);
  const engines = manifest?.json.engines?.node;
  // An empty value says nothing, so it counts as missing.
  if (engines === undefined || (typeof engines === "string" && engines.trim() === "")) {
    return undefined;
  }

  const file = manifest!.file;
  const range = typeof engines === "string" ? semver.validRange(engines) : null;
  if (range === null || hasPrerelease(engines as string)) {
    throw new ProjectStateError(
      `runtime "${runtime.name}": cannot parse engines.node ${JSON.stringify(engines)} in ${file}. ` +
        `Use a semver range such as ">=20", or set runtimeVersion in agentcore.json.`,
    );
  }
  const versions = [...NODE_VERSIONS]
    .reverse()
    .filter(({ major }) => semver.intersects(range, `>=${major}.0.0 <${major + 1}.0.0`))
    .map(({ option }) => option);
  if (versions.length === 0) {
    throw new ProjectStateError(
      `runtime "${runtime.name}": engines.node "${engines}" in ${file} matches no supported ` +
        `Node.js version (supported: ${NODE_VERSIONS.map(({ major }) => major).join(", ")}).`,
    );
  }
  return { versions, source: `engines.node "${engines}" in ${file}` };
}

/**
 * Whether a range as written names a prerelease version (`^20.0.0-beta.1`), which
 * the L3 treats as unparseable. Checked on the written text: semver's normalized
 * ranges add `-0` prerelease bounds of their own (`^20` -> `<21.0.0-0`).
 */
function hasPrerelease(range: string): boolean {
  return /\d+\.\d+\.\d+-[0-9A-Za-z]/.test(range);
}

/** `PYTHON_3_14` -> `Python 3.14`, `NODE_22` -> `Node.js 22`. */
export function versionLabel(version: RuntimeVersion): string {
  const [kind, ...parts] = version.split("_");
  return kind === "PYTHON" ? `Python ${parts.join(".")}` : `Node.js ${parts.join(".")}`;
}

/**
 * Finds a manifest the way the packagers do: in the code folder, then each
 * parent up to (and including) the project root.
 */
export function findManifest(
  fileName: string,
  runtime: ProjectRuntime,
  projectRoot: string,
): string | undefined {
  const root = resolve(projectRoot);
  let current = resolve(root, runtime.codeLocation);
  for (;;) {
    const candidate = join(current, fileName);
    if (isFile(candidate)) return candidate;
    if (current === root || !isWithin(root, current)) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The directory a Dockerfile is looked up in: buildContextPath, else codeLocation. */
export function contextDir(runtime: ProjectRuntime, projectRoot: string): string {
  return resolve(projectRoot, runtime.buildContextPath ?? runtime.codeLocation);
}

/** A project-relative, forward-slash path for messages. */
export function displayPath(projectRoot: string, path: string): string {
  const relativePath = relative(resolve(projectRoot), path);
  return (relativePath === "" ? "." : relativePath).split(sep).join("/");
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type Clause = { operator: string; release: number[]; wildcard: boolean };

/** Parses a PEP 440 specifier set (comma = AND). Returns undefined when any clause is invalid. */
export function parseSpecifierSet(value: string): Clause[] | undefined {
  const clauses: Clause[] = [];
  for (const part of value.split(",")) {
    const clause = /^\s*(~=|==|!=|<=|>=|<|>)\s*[vV]?(\d+(?:\.\d+)*)(\.\*)?\s*$/.exec(part);
    if (!clause) return undefined;
    const [, operator = "", version = "", wildcard] = clause;
    if (wildcard && operator !== "==" && operator !== "!=") return undefined;
    const release = version.split(".").map(Number);
    if (operator === "~=" && release.length < 2) return undefined;
    clauses.push({ operator, release, wildcard: wildcard !== undefined });
  }
  return clauses;
}

/** Whether some patch release major.minor.p (p in 0..99) satisfies every clause. */
function pythonMinorSatisfies(major: number, minor: number, clauses: Clause[]): boolean {
  for (let patch = 0; patch <= 99; patch++) {
    const candidate = [major, minor, patch];
    if (clauses.every((clause) => clauseMatches(candidate, clause))) return true;
  }
  return false;
}

function clauseMatches(candidate: number[], { operator, release, wildcard }: Clause): boolean {
  const order = compareReleases(candidate, release);
  switch (operator) {
    case "==":
      return wildcard ? hasPrefix(candidate, release) : order === 0;
    case "!=":
      return wildcard ? !hasPrefix(candidate, release) : order !== 0;
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    case "~=":
      return order >= 0 && hasPrefix(candidate, release.slice(0, -1));
    default:
      return false;
  }
}

function compareReleases(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function hasPrefix(candidate: number[], prefix: number[]): boolean {
  return prefix.every((segment, i) => (candidate[i] ?? 0) === segment);
}

export interface PreparedRuntimes {
  /** Every runtime, re-derived from its code folder. */
  runtimes: ProjectRuntime[];
  /** The runtimes whose settings changed, to write back to agentcore.json. */
  changed: RuntimeSync[];
  /** A line per changed field, then any warnings. */
  messages: string[];
}

/**
 * Checks and re-derives the runtimes `dev` or `deploy` is about to run. Every
 * problem across them is reported in one error, each pointing at the runtime's
 * README.
 */
export function prepareRuntimes(
  projectRoot: string,
  runtimes: ProjectRuntime[],
  purpose: "dev" | "deploy",
): PreparedRuntimes {
  const prepared: ProjectRuntime[] = [];
  const changed: RuntimeSync[] = [];
  const messages: string[] = [];
  const problems: string[] = [];
  for (const runtime of runtimes) {
    const readme = `${displayPath(projectRoot, resolve(projectRoot, runtime.codeLocation))}/README.md`;
    const pointAtReadme = (found: string[]) =>
      problems.push(...found.map((problem) => `${problem.replace(/\.?$/, ".")} See ${readme}.`));
    const folder = resolve(projectRoot, runtime.codeLocation);
    if (!isDirectory(folder)) {
      pointAtReadme([
        `runtime "${runtime.name}": ${displayPath(projectRoot, folder)}/ does not exist.`,
      ]);
      continue;
    }
    let sync: RuntimeSync;
    try {
      sync = syncRuntimeBuild(runtime, projectRoot);
    } catch (error) {
      if (!(error instanceof ProjectStateError)) throw error;
      pointAtReadme([error.message]);
      continue;
    }
    const found = runtimeProblems(sync.runtime, projectRoot, purpose);
    if (found.length > 0) {
      pointAtReadme(found);
      continue;
    }
    prepared.push(sync.runtime);
    if (sync.changes.length > 0) changed.push(sync);
    messages.push(...sync.changes.map((change) => describeChange(runtime.name, change)));
    messages.push(...sync.warnings);
  }
  if (problems.length > 0) throw new ProjectStateError(problems.join("\n"));
  return { runtimes: prepared, changed, messages };
}

/** What a re-derived runtime's folder is missing for its build. */
function runtimeProblems(
  runtime: ProjectRuntime,
  projectRoot: string,
  purpose: "dev" | "deploy",
): string[] {
  const prefix = `runtime "${runtime.name}":`;
  const folder = resolve(projectRoot, runtime.codeLocation);
  const folderLabel = `${displayPath(projectRoot, folder)}/`;
  const problems: string[] = [];
  if (runtime.build === "Container") {
    const context = contextDir(runtime, projectRoot);
    const dockerfile = runtime.dockerfile ?? DOCKERFILE_NAME;
    if (!isFile(join(context, dockerfile))) {
      const missing =
        dockerfile === DOCKERFILE_NAME
          ? `no Dockerfile in ${displayPath(projectRoot, context)}/`
          : `no Dockerfile at ${displayPath(projectRoot, join(context, dockerfile))}`;
      problems.push(
        `${prefix} ${missing}, and agentcore.json says this is a Container build. Add the ` +
          `Dockerfile, or deploy the code directly: in agentcore.json, ` +
          `${codeZipRevertEdits(runtime)}.`,
      );
    }
    if (runtime.networkMode === "VPC" && !runtime.networkConfig?.vpcId) {
      problems.push(
        `${prefix} networkConfig.vpcId is required for Container builds in VPC mode ` +
          `(CodeBuild cannot infer the VPC from subnets).`,
      );
    }
    return problems;
  }

  const [entrypoint = ""] = runtime.entrypoint.split(":");
  const has = (file: string) => isFile(join(folder, file));
  if (entrypoint.endsWith(".py")) {
    if (findManifest("pyproject.toml", runtime, projectRoot) === undefined) {
      problems.push(
        has("package.json")
          ? `${prefix} this runtime is Python (entrypoint ${entrypoint}) but ${folderLabel} has a ` +
              `package.json and no pyproject.toml.`
          : `${prefix} no pyproject.toml in ${folderLabel}.`,
      );
    }
    if (!has(entrypoint)) problems.push(`${prefix} no ${entrypoint} in ${folderLabel}.`);
  } else {
    if (findManifest("package.json", runtime, projectRoot) === undefined) {
      problems.push(
        has("pyproject.toml")
          ? `${prefix} this runtime is TypeScript (entrypoint ${entrypoint}) but ${folderLabel} has ` +
              `a pyproject.toml and no package.json.`
          : `${prefix} no package.json in ${folderLabel}.`,
      );
    }
    // The deploy packager always bundles from main.ts (the spec records the bundle,
    // main.js); dev also runs a plain JavaScript entrypoint.
    if (!has("main.ts") && (purpose === "deploy" || !has(entrypoint))) {
      problems.push(`${prefix} no main.ts in ${folderLabel}.`);
    }
    // `dev` installs missing Node dependencies itself; deploy bundles from them.
    if (purpose === "deploy" && !isDirectory(join(folder, "node_modules"))) {
      problems.push(`${prefix} no node_modules in ${folderLabel}; run \`npm install\` there.`);
    }
  }
  return problems;
}
