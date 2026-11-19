import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../../handlers/project/types";
import {
  BOX_CODEZIP_DIST,
  renderRuntimeBoxProfile,
  runsBoxStartScript,
} from "../templates/boxProfile";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";

/**
 * Stages box into each CodeZip runtime whose entry point is the box start
 * script, so the zip carries it: `<codeLocation>/.box-dist/` gets box, its
 * helpers, its packs, the libffi shim built for the runtime's Python, and the
 * Runtime profile, rendered from agentcore.json. The folder is rewritten on
 * every build and deploy. `box` is asked for only when a runtime needs it.
 * Returns the names of the runtimes it staged.
 */
export async function stageBoxCodeZip(
  project: Project,
  box: () => Promise<BoxLinuxBuild>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter(
    (runtime) => runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint),
  );
  if (runtimes.length === 0) return [];
  const build = await box();

  for (const runtime of runtimes) {
    const dist = join(project.rootPath, runtime.codeLocation, BOX_CODEZIP_DIST);
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    for (const binary of BOX_BINARIES) {
      copyFileSync(join(build.binaries, binary), join(dist, binary));
      chmodSync(join(dist, binary), 0o755);
    }
    cpSync(build.resources, join(dist, "resources"), { recursive: true });
    const ffi = runtime.runtimeVersion ? build.ffi[runtime.runtimeVersion] : undefined;
    if (ffi) cpSync(ffi, join(dist, "ffi"), { recursive: true });
    writeFileSync(join(dist, "profile.toml"), renderRuntimeBoxProfile(project.spec, runtime));
  }
  return runtimes.map((runtime) => runtime.name);
}
