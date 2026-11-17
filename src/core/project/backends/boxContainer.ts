import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { BoxNetwork } from "../boxNetwork";
import { boxNetworkEdits, runtimeProfileWriter, writeBoxNetworkFiles } from "../boxNetworkWriters";
import { isFile } from "../runtimeBuild";
import { runsBoxStartScript } from "../templates/boxProfile";
import { assertImageCopiesPolicyFiles, assertStartScriptCopiesPolicyFiles } from "./boxStaging";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";

/** The folder a box image's Dockerfile copies its box profile and policy files from. */
export const BOX_IMAGE_DIST = ".box-dist";

/**
 * The folder `agentcore dev` stages a box image into, when the Dockerfile names its folder with
 * {@link BOX_DIST_ARG}, so dev never overwrites the Runtime profile build and deploy stage in
 * {@link BOX_IMAGE_DIST}. Dev removes it once the image is built.
 */
export const BOX_DEV_DIST = ".box-dev";

/** The build argument that names the folder a box image copies, in a Dockerfile that declares it. */
export const BOX_DIST_ARG = "BOX_DIST";

/** A Dockerfile line that copies the folder {@link BOX_DIST_ARG} names. */
const COPIES_DIST_ARG = new RegExp(
  `^\\s*COPY\\s+(?:--\\S+\\s+)*\\$\\{${BOX_DIST_ARG}\\}\\/?\\s`,
  "m",
);
const DECLARES_DIST_ARG = new RegExp(`^\\s*ARG\\s+${BOX_DIST_ARG}\\b`, "m");

/** The folder a container runtime's image builds from. */
export function containerBuildContext(projectRoot: string, runtime: ProjectRuntime): string {
  return join(projectRoot, runtime.buildContextPath ?? runtime.codeLocation);
}

/** Whether a container runtime's Dockerfile copies the staged box in. */
export function imageCopiesBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  if (runtime.build !== "Container") return false;
  const dockerfile = dockerfileOf(projectRoot, runtime);
  if (!isFile(dockerfile)) return false;
  const text = readFileSync(dockerfile, "utf8");
  return text.includes(`${BOX_IMAGE_DIST}/`) || COPIES_DIST_ARG.test(text);
}

/**
 * Whether a box image's Dockerfile takes the folder it copies from {@link BOX_DIST_ARG}, so dev
 * can stage into {@link BOX_DEV_DIST}. A Dockerfile from an older template copies `.box-dist/`
 * by name, and dev stages there as before.
 */
export function imageTakesBoxDistArg(projectRoot: string, runtime: ProjectRuntime): boolean {
  if (!imageCopiesBox(projectRoot, runtime)) return false;
  const text = readFileSync(dockerfileOf(projectRoot, runtime), "utf8");
  return DECLARES_DIST_ARG.test(text) && COPIES_DIST_ARG.test(text);
}

/** The Dockerfile a container runtime's image builds from. */
function dockerfileOf(projectRoot: string, runtime: ProjectRuntime): string {
  return join(containerBuildContext(projectRoot, runtime), runtime.dockerfile ?? "Dockerfile");
}

/** A policy file to copy into an image's `.box-dist/`: the file, and its path from `.box/`. */
export interface PolicyFileCopy {
  readonly from: string;
  readonly relative: string;
}

/**
 * Writes `<context>/.box-dist/` for a box image under `agentcore dev`: `profileText`, the profile
 * the image runs, and each policy file of `policies` at its path from `.box/`. The image's
 * Dockerfile installs box itself, from the box release. The folder is rewritten each time.
 */
export function stageBoxImage(
  context: string,
  profileText: string,
  policies: readonly PolicyFileCopy[] = [],
  build?: BoxLinuxBuild,
  folder: string = BOX_IMAGE_DIST,
): void {
  const dist = join(context, folder);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  if (build) copyBox(build, dist);
  writeFileSync(join(dist, "profile.toml"), profileText);
  for (const { from, relative } of policies) {
    const to = join(dist, ...relative.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * Stages box for build and deploy into each container runtime whose
 * Dockerfile copies `.box-dist/`: what the runtime profile writer writes from
 * the runtime's Box network model, the Runtime profile and a byte copy of each
 * policy file it names. Returns the names of the runtimes it staged.
 */
export async function stageBoxContainers(
  project: Project,
  networks: readonly BoxNetwork[],
  box: (version: string | undefined) => Promise<BoxLinuxBuild>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter((runtime) =>
    imageCopiesBox(project.rootPath, runtime),
  );
  if (runtimes.length === 0) return [];
  const staged = runtimes.map((runtime) => ({
    runtime: runtime.name,
    dist: posix.join(runtime.buildContextPath ?? runtime.codeLocation, BOX_IMAGE_DIST),
  }));
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
  });
  const filesOf = (dist: string) => files.filter(({ path }) => path.startsWith(`${dist}/`));
  for (const runtime of runtimes) {
    const policyFiles = networks.find((n) => n.runtime === runtime.name)?.policyFiles ?? [];
    const context = containerBuildContext(project.rootPath, runtime);
    assertImageCopiesPolicyFiles(
      dockerfileOf(project.rootPath, runtime),
      runtime.name,
      policyFiles,
    );
    assertStartScriptCopiesPolicyFiles(join(context, "start.sh"), runtime.name, policyFiles);
  }
  // One build for each box version the runtimes name, so each downloads once.
  const builds = new Map<string | undefined, BoxLinuxBuild>();
  for (const runtime of runtimes) {
    const version = runtime.box?.version;
    if (!builds.has(version)) builds.set(version, await box(version));
  }
  for (const { runtime, dist } of staged) {
    const entry = runtimes.find(({ name }) => name === runtime)!;
    const folder = join(project.rootPath, ...dist.split("/"));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    copyBox(builds.get(entry.box?.version)!, folder);
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
  }
  return runtimes.map((runtime) => runtime.name);
}

/**
 * The runtimes whose image runs the agent in a box but whose agentcore.json still turns OpenTelemetry
 * on. The image does not run `opentelemetry-instrument`, so these send no traces.
 */
export function boxedContainersWithOtel(project: Project): string[] {
  return project.spec.runtimes
    .filter(
      (runtime) =>
        imageCopiesBox(project.rootPath, runtime) && (runtime.instrumentation?.enableOtel ?? true),
    )
    .map((runtime) => runtime.name);
}

/**
 * Whether a runtime runs its agent in a box on AgentCore Runtime: a CodeZip
 * runtime whose entry point is the box start script, or a container runtime
 * whose Dockerfile copies `.box-dist/`.
 */
export function runsAgentInBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  return (
    (runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint)) ||
    imageCopiesBox(projectRoot, runtime)
  );
}

/**
 * Copies box, its helpers and its packs into an image's `.box-dist/`, which its Dockerfile copies
 * into /opt/box, so the image runs the box release of the runtime's `box.version`.
 */
function copyBox(build: BoxLinuxBuild, dist: string): void {
  for (const binary of BOX_BINARIES) {
    copyFileSync(join(build.binaries, binary), join(dist, binary));
    chmodSync(join(dist, binary), 0o755);
  }
  cpSync(build.resources, join(dist, "resources"), { recursive: true });
}
