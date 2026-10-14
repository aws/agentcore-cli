import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationCheck } from "../../../handlers/project/migrate/types";
import type { CfnTemplate } from "./templates";
import { resourcesOf } from "./templates";
import { V0_CDK_APPS, V0_CDK_DEPENDENCY_NAMES, type V0CdkApp } from "./v0CdkApps";

/**
 * Migrating replaces agentcore/cdk with v1's app. That's only safe when the app is
 * exactly what a v0 release generated: anything the user added there would be
 * lost, and resources it creates deleted by the first v1 deploy.
 */
/** The v0 CDK app's directory, relative to the project root; migrating replaces it. */
export const CDK_APP_DIRECTORY = "agentcore/cdk";

/** The v0 CDK app's source files, relative to the project root. */
export const V0_APP_FILES = [
  join("agentcore", "cdk", "bin", "cdk.ts"),
  join("agentcore", "cdk", "lib", "cdk-stack.ts"),
] as const;

/**
 * Directories in agentcore/cdk that aren't the app's own files: installed
 * dependencies, synth output, and the TypeScript build. Never compared.
 */
const GENERATED_DIRECTORIES = new Set(["node_modules", "cdk.out", "dist"]);

/** Written by `npm install`, not vended; checked only for the packages it records. */
const LOCKFILE = "package-lock.json";
const MANIFEST = "package.json";

/** The newest `@aws/agentcore-cdk` v0 library (0.1.0-alpha.N) a recognized release vended. */
export const NEWEST_KNOWN_V0_LIBRARY_ALPHA = 54;

/**
 * The fingerprint of a source file, insensitive to formatting: comments,
 * whitespace, quotes, and the punctuation Prettier adds or drops (semicolons,
 * trailing commas, leading union bars, arrow-function parentheses) are ignored,
 * so a file `agentcore create` reformatted still matches the asset it came from.
 */
export function sourceFingerprint(source: string): string {
  const normalized = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/["`]/g, "'")
    .replace(/[\s;,|()]/g, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

type Manifest = Record<string, unknown> & {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

/**
 * The fingerprint of a package.json without its dependency versions: the v0
 * CLI's deploy re-pins the CDK app's dependencies (and restores managed ones a
 * user deleted), so only the rest of the manifest has to match what was vended.
 */
export function manifestFingerprint(manifest: Manifest): string {
  const { dependencies: _dependencies, devDependencies: _devDependencies, ...rest } = manifest;
  return createHash("sha256").update(stableJson(rest)).digest("hex").slice(0, 16);
}

/** The names of a manifest's dependencies and devDependencies. */
export function dependencyNames(manifest: Manifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Apps of releases migrate doesn't support: the pre-GA 0.3.0 previews laid
 * projects out differently. (0.3.0-preview.9.0 vended the same app as v0.4.0.)
 */
const UNSUPPORTED_APP_FINGERPRINTS: readonly { bin: string; lib: string; releases: string }[] = [
  { bin: "bb8eb101dfdd3f64", lib: "861c221446b7a5ae", releases: "0.3.0-preview" },
];

/** The 0.1.0-alpha.N of an `@aws/agentcore-cdk` dependency spec (`0.1.0-alpha.54`, `^0.1.0-alpha.19`). */
function v0LibraryAlpha(spec: unknown): number | undefined {
  const match = typeof spec === "string" ? /^\^?0\.1\.0-alpha\.(\d+)$/.exec(spec.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

/** Every file under agentcore/cdk, relative to it and `/`-separated, outside the generated directories. */
async function cdkAppFiles(rootPath: string): Promise<string[]> {
  const root = join(rootPath, ...CDK_APP_DIRECTORY.split("/"));
  const files: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Skipped by name, whatever they are: node_modules is often a symlink.
      if (GENERATED_DIRECTORIES.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      const isDirectory = entry.isSymbolicLink()
        ? (await stat(full).catch(() => undefined))?.isDirectory() === true
        : entry.isDirectory();
      if (isDirectory) await walk(full, path);
      else files.push(path);
    }
  };
  await walk(root, "");
  return files.sort();
}

/** What a project's agentcore/cdk is made of, read once for comparing with each vended app. */
type CdkAppContents = {
  /** Fingerprint of each file but the manifest and lockfile, by path relative to agentcore/cdk. */
  sources: Map<string, string>;
  /** The manifest's fingerprint and dependency names; undefined when it's missing or invalid. */
  manifest?: { fingerprint: string; dependencies: string[]; library: unknown };
  hasManifest: boolean;
  /** Whether a lockfile is present, and whether it's valid and records only the manifest's packages. */
  lockfile?: { valid: boolean };
};

async function readCdkApp(rootPath: string): Promise<CdkAppContents> {
  const directory = join(rootPath, ...CDK_APP_DIRECTORY.split("/"));
  const files = await cdkAppFiles(rootPath);
  const contents: CdkAppContents = { sources: new Map(), hasManifest: files.includes(MANIFEST) };
  const read = (file: string) => readFile(join(directory, ...file.split("/")), "utf8");
  for (const file of files) {
    if (file === MANIFEST || file === LOCKFILE) continue;
    contents.sources.set(file, sourceFingerprint(await read(file)));
  }
  if (contents.hasManifest) {
    try {
      const manifest = JSON.parse(await read(MANIFEST)) as Manifest;
      contents.manifest = {
        fingerprint: manifestFingerprint(manifest),
        dependencies: dependencyNames(manifest),
        library: manifest.dependencies?.["@aws/agentcore-cdk"],
      };
    } catch {
      // Reported as a modified file.
    }
  }
  if (files.includes(LOCKFILE)) {
    contents.lockfile = { valid: false };
    try {
      const lock = JSON.parse(await read(LOCKFILE)) as {
        lockfileVersion?: number;
        packages?: Record<string, Manifest>;
        dependencies?: unknown;
      };
      const root = lock.packages?.[""];
      const allowed = new Set(contents.manifest?.dependencies ?? V0_CDK_DEPENDENCY_NAMES);
      // npm 7+ records the project's own dependencies under packages[""]; npm 6's
      // version-1 lockfile lists only resolved packages, so there's nothing to compare.
      contents.lockfile.valid = root
        ? dependencyNames(root).every((name) => allowed.has(name))
        : lock.lockfileVersion === 1 && typeof lock.dependencies === "object";
    } catch {
      // Reported as a modified file.
    }
  }
  return contents;
}

/** How a project's CDK app differs from one vended app: files it added, and files it changed. */
function differences(
  contents: CdkAppContents,
  app: V0CdkApp,
): { added: string[]; modified: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  for (const [file, fingerprint] of contents.sources) {
    const vended = app.files[file];
    if (vended === undefined) added.push(file);
    else if (vended !== fingerprint) modified.push(file);
  }
  if (contents.hasManifest) {
    const known = new Set(V0_CDK_DEPENDENCY_NAMES);
    if (
      contents.manifest === undefined ||
      contents.manifest.fingerprint !== app.packageJson ||
      !contents.manifest.dependencies.every((name) => known.has(name))
    ) {
      modified.push(MANIFEST);
    }
  }
  if (contents.lockfile && !contents.lockfile.valid) modified.push(LOCKFILE);
  return { added, modified };
}

/**
 * The project's agentcore/cdk must be exactly what a v0 release vended: migrating
 * replaces the whole directory with v1's app, so anything the user added or
 * changed there (custom constructs, escape hatches, helper files, extra
 * dependencies) would be lost, and resources it creates deleted by the first v1
 * deploy. Every file is compared with each known release's (formatting aside),
 * except what isn't the app's own: node_modules, cdk.out, dist, and the lockfile
 * (checked only for the packages it records). The manifest may differ only in its
 * dependency versions, which the v0 CLI re-pins on deploy. An app that matches no
 * release is either edited or from a release this CLI doesn't know; the
 * `@aws/agentcore-cdk` version tells them apart.
 */
export async function checkCdkApp(rootPath: string): Promise<MigrationCheck> {
  const name = "cdk app";
  let contents: CdkAppContents;
  try {
    contents = await readCdkApp(rootPath);
  } catch (error) {
    return { name, ok: false, message: `Couldn't read the CDK app: ${(error as Error).message}` };
  }
  const bin = contents.sources.get("bin/cdk.ts");
  const lib = contents.sources.get("lib/cdk-stack.ts");
  if (bin === undefined || lib === undefined) {
    const missing = [bin === undefined && "bin/cdk.ts", lib === undefined && "lib/cdk-stack.ts"]
      .filter(Boolean)
      .map((file) => `${CDK_APP_DIRECTORY}/${file}`);
    return {
      name,
      ok: false,
      message: `Couldn't read the CDK app: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.`,
    };
  }

  const comparisons = V0_CDK_APPS.map((app) => ({ app, ...differences(contents, app) }));
  const exact = comparisons.find(
    (comparison) => comparison.added.length + comparison.modified.length === 0,
  );
  if (exact) {
    return { name, ok: true, message: `unchanged from the app v0 ${exact.app.releases} created` };
  }
  const unsupported = UNSUPPORTED_APP_FINGERPRINTS.find(
    (app) => app.bin === bin && app.lib === lib,
  );
  if (unsupported) {
    return {
      name,
      ok: false,
      message:
        `This project was created by a ${unsupported.releases} release, which agentcore migrate ` +
        "doesn't support. Create a new project with the current CLI and move your agent code into it.",
    };
  }
  const alpha = v0LibraryAlpha(contents.manifest?.library);
  if (alpha !== undefined && alpha > NEWEST_KNOWN_V0_LIBRARY_ALPHA) {
    return {
      name,
      ok: false,
      message:
        `This project's CDK app comes from a v0 CLI release newer than this CLI recognizes ` +
        `(@aws/agentcore-cdk ${String(contents.manifest?.library)}). Update the AgentCore CLI and run agentcore migrate again.`,
    };
  }

  // Report against the release the project is closest to: its source files say which.
  const closest = [...comparisons].sort(
    (a, b) =>
      Number(b.app.files["bin/cdk.ts"] === bin && b.app.files["lib/cdk-stack.ts"] === lib) -
        Number(a.app.files["bin/cdk.ts"] === bin && a.app.files["lib/cdk-stack.ts"] === lib) ||
      a.added.length + a.modified.length - (b.added.length + b.modified.length),
  )[0]!;
  const rows = [
    ...closest.added.map((file) => `  added     ${CDK_APP_DIRECTORY}/${file}`),
    ...closest.modified.map((file) => `  modified  ${CDK_APP_DIRECTORY}/${file}`),
  ];
  const changed = [
    ...closest.added.map((file) => `added ${file}`),
    ...closest.modified.map((file) => `modified ${file}`),
  ];
  const shown = changed.slice(0, SUMMARY_FILE_LIMIT);
  const more = changed.length - shown.length;
  return {
    name,
    ok: false,
    summary:
      `${CDK_APP_DIRECTORY} differs from the app v0 generated, and migrating replaces it, so ` +
      `these changes would be lost: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
    message: [
      `${CDK_APP_DIRECTORY} isn't the CDK app a release that creates v0 projects (v0.4.0 to ` +
        `v0.31.1, 1.0.0-preview.1 to 1.0.0-preview.33) created; compared with v0 ` +
        `${closest.app.releases}:`,
      ...rows,
      "Migrating replaces agentcore/cdk with v1's app, so these files would be lost, and any " +
        "resources custom code there creates would be deleted by the first v1 deploy. Move custom " +
        "code and files out of agentcore/cdk, or revert them (`git checkout -- <path>`, and delete " +
        "added files); if that changes the stack, deploy with the v0 CLI " +
        "(`npx @aws/agentcore@0 deploy`). Then run agentcore migrate again. If you didn't change " +
        "these files, the project comes from a CLI release this CLI doesn't recognize; update the " +
        "AgentCore CLI and run agentcore migrate again.",
    ].join("\n"),
  };
}

/** How many changed files the summary names before counting the rest. */
const SUMMARY_FILE_LIMIT = 5;

/** Whether the project's v0 app builds harness containers itself (`hasDockerfile`, v0.16.0 and later). */
export async function appBuildsHarnessContainers(rootPath: string): Promise<boolean> {
  try {
    const source = await readFile(join(rootPath, V0_APP_FILES[0]), "utf8");
    return /\bhasDockerfile\s*:/.test(source);
  } catch {
    return false;
  }
}

/**
 * The construct IDs directly under a v0 stack: what the v0 app creates there
 * (`Application`, `Mcp`, and `Payment<name>…`), what the v0 library adds at the
 * stack root (in every `@aws/agentcore-cdk` 0.1.0-alpha.45 to alpha.54, the
 * versions migrate accepts: `ContainerBuildProject.getOrCreate` puts the shared
 * container build project at `ContainerBuildProject`, or
 * `ContainerBuildProject-<8-hex network hash>` for a VPC build, and
 * `AgentCorePayments` puts managers and connectors at `Payment<name>…`; nothing
 * else in the library scopes a construct to `Stack.of(...)`), and what CDK itself
 * adds: the `CDKMetadata` resource and singleton providers (`AWSCDK…`,
 * `AWS<hash>`, `Custom…`, `LogRetention<hash>`, `BucketNotificationsHandler<hash>`).
 */
const V0_ROOT_CONSTRUCTS = [
  /^Application$/,
  /^Mcp$/,
  /^Payment/,
  /^ContainerBuildProject(-[0-9a-f]{8})?$/,
  /^CDKMetadata$/,
  /^AWSCDK/,
  /^AWS[0-9a-f]{32}$/,
  /^Custom/,
  /^LogRetention[0-9a-f]+$/,
  /^BucketNotificationsHandler/,
];

/**
 * Deployed resources the v0 app couldn't have created: their `aws:cdk:path`
 * metadata puts them under a construct the v0 stack doesn't define, so a
 * customized app (or another tool) added them. Resources without the metadata
 * aren't judged.
 */
export function resourcesOutsideV0App(deployed: CfnTemplate): string[] {
  const outside: string[] = [];
  for (const [logicalId, resource] of Object.entries(resourcesOf(deployed))) {
    const path = (resource.Metadata as Record<string, unknown> | undefined)?.["aws:cdk:path"];
    if (typeof path !== "string") continue;
    const root = path.split("/")[1];
    if (root === undefined || V0_ROOT_CONSTRUCTS.some((pattern) => pattern.test(root))) continue;
    outside.push(`${logicalId} (${resource.Type}, ${path})`);
  }
  return outside;
}
