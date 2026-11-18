import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { BoxNetwork } from "../boxNetwork";
import { boxNetworkEdits, runtimeProfileWriter, writeBoxNetworkFiles } from "../boxNetworkWriters";
import { isFile } from "../runtimeBuild";
import { boxAwsDir, runsBoxStartScript } from "../templates/boxProfile";
import type { BoxRelease } from "./boxRelease";
import { assertImageCopiesPolicyFiles } from "./boxStaging";

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

/** A Dockerfile line that copies `.box-dist/` by name; a comment that names it does not count. */
const COPIES_DIST_FOLDER = new RegExp(
  `^\\s*(?:COPY|ADD)\\b[^\\n]*${BOX_IMAGE_DIST.replace(".", "\\.")}/`,
  "im",
);

/** Whether a container runtime's Dockerfile copies the staged box in. */
export function imageCopiesBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  if (runtime.build !== "Container") return false;
  const dockerfile = dockerfileOf(projectRoot, runtime);
  if (!isFile(dockerfile)) return false;
  const text = readFileSync(dockerfile, "utf8");
  return COPIES_DIST_FOLDER.test(text) || COPIES_DIST_ARG.test(text);
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

/** The file that tells the image's Dockerfile which box release to download, and its checksum. */
const BOX_RELEASE_ENV = "box-release.env";

function boxReleaseEnv({ repo, version, linux }: BoxRelease): string {
  return `BOX_REPO=${repo}\nBOX_VERSION=${version}\nBOX_ASSET=${linux.asset}\nBOX_SHA256=${linux.sha256}\n`;
}

/**
 * Writes `<context>/<folder>` for a box image: `profileText`, the profile the image runs, each
 * policy file of `policies` at its path from the agent's local box folder, and the box release the Dockerfile downloads.
 * The folder is rewritten each time.
 */
export function stageBoxImage(
  context: string,
  profileText: string,
  policies: readonly PolicyFileCopy[],
  release: BoxRelease,
  folder: string = BOX_IMAGE_DIST,
): void {
  const dist = join(context, folder);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "profile.toml"), profileText);
  writeFileSync(join(dist, BOX_RELEASE_ENV), boxReleaseEnv(release));
  for (const { from, relative } of policies) {
    const to = join(dist, ...relative.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * Stages box for build and deploy into each container runtime whose Dockerfile copies `.box-dist/`.
 * It generates the canonical AWS tree in `box/<name>/aws/`: the box release its `box.version` names,
 * and what the runtime profile writer writes from the runtime's Box network model (the Runtime
 * profile and a byte copy of each policy file it names). It then copies that tree into the build
 * context's `.box-dist/`, so the image copies it. Returns the names of the runtimes it staged.
 */
export async function stageBoxContainers(
  project: Project,
  networks: readonly BoxNetwork[],
  releaseFor: (version: string | undefined) => Promise<BoxRelease>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter((runtime) =>
    imageCopiesBox(project.rootPath, runtime),
  );
  if (runtimes.length === 0) return [];
  const staged = runtimes.map((runtime) => ({
    runtime: runtime.name,
    dist: boxAwsDir(runtime.name),
    container: runtime.build === "Container",
    codezip: false,
  }));
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
  });
  const filesOf = (dist: string) => files.filter(({ path }) => path.startsWith(`${dist}/`));
  for (const runtime of runtimes) {
    const policyFiles = networks.find((n) => n.runtime === runtime.name)?.policyFiles ?? [];
    assertImageCopiesPolicyFiles(
      dockerfileOf(project.rootPath, runtime),
      runtime.name,
      policyFiles,
    );
  }
  for (const [index, { dist }] of staged.entries()) {
    const runtime = runtimes[index]!;
    const folder = join(project.rootPath, ...dist.split("/"));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const release = await releaseFor(runtime.box?.version);
    writeFileSync(join(folder, BOX_RELEASE_ENV), boxReleaseEnv(release));
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
    // Copy the canonical AWS tree into the build context's .box-dist so the image copies it.
    const contextDist = join(containerBuildContext(project.rootPath, runtime), BOX_IMAGE_DIST);
    rmSync(contextDist, { recursive: true, force: true });
    cpSync(folder, contextDist, { recursive: true });
  }
  return runtimes.map((runtime) => runtime.name);
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
