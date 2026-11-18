import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { isFile } from "../runtimeBuild";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";

/** The folder a box image's Dockerfile copies box and its profile from, in its build context. */
export const BOX_IMAGE_DIST = ".box-dist";

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
  const dockerfile = join(
    containerBuildContext(projectRoot, runtime),
    runtime.dockerfile ?? "Dockerfile",
  );
  return isFile(dockerfile) && COPIES_DIST_FOLDER.test(readFileSync(dockerfile, "utf8"));
}

/**
 * Writes `<context>/.box-dist/` for a box image under `agentcore dev`: box, its helpers and its
 * packs from `build`, the Linux build of the runtime's box release, and `profileText`, the
 * profile the image runs. The folder is rewritten each time.
 */
export function stageBoxImage(context: string, profileText: string, build: BoxLinuxBuild): void {
  const dist = join(context, BOX_IMAGE_DIST);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const binary of BOX_BINARIES) {
    copyFileSync(join(build.binaries, binary), join(dist, binary));
    chmodSync(join(dist, binary), 0o755);
  }
  cpSync(build.resources, join(dist, "resources"), { recursive: true });
  writeFileSync(join(dist, "profile.toml"), profileText);
}
