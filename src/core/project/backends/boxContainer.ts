import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { BoxNetwork } from "../boxNetwork";
import { boxNetworkEdits, runtimeProfileWriter, writeBoxNetworkFiles } from "../boxNetworkWriters";
import { isFile } from "../runtimeBuild";
import { runsBoxStartScript } from "../templates/boxProfile";
import { assertImageCopiesPolicyFiles, assertStartScriptCopiesPolicyFiles } from "./boxStaging";

/** The folder a box image's Dockerfile copies its box profile and policy files from. */
export const BOX_IMAGE_DIST = ".box-dist";

/** The folder a container runtime's image builds from. */
export function containerBuildContext(projectRoot: string, runtime: ProjectRuntime): string {
  return join(projectRoot, runtime.buildContextPath ?? runtime.codeLocation);
}

/** Whether a container runtime's Dockerfile copies the staged box in. */
export function imageCopiesBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  if (runtime.build !== "Container") return false;
  const dockerfile = dockerfileOf(projectRoot, runtime);
  return isFile(dockerfile) && readFileSync(dockerfile, "utf8").includes(`${BOX_IMAGE_DIST}/`);
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
): void {
  const dist = join(context, BOX_IMAGE_DIST);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
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
export function stageBoxContainers(project: Project, networks: readonly BoxNetwork[]): string[] {
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
  for (const { dist } of staged) {
    const folder = join(project.rootPath, ...dist.split("/"));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
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
