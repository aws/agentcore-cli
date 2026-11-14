import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { boxNetworkEdits, runtimeProfileWriter, writeBoxNetworkFiles } from "../boxNetworkWriters";
import { BOX_CODEZIP_DIST, runsBoxStartScript } from "../templates/boxProfile";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";
import { assertStartScriptCopiesPolicyFiles } from "./boxStaging";

/**
 * Stages box into each CodeZip runtime whose entry point is the box start
 * script, so the zip carries it: `<codeLocation>/.box-dist/` gets box, its
 * helpers, its packs, the libffi shim built for the runtime's Python, and what
 * the runtime profile writer writes from the runtime's Box network model: the
 * Runtime profile and a byte copy of each policy file it names. The folder is
 * rewritten on every build and deploy. `box` is asked for only when a runtime
 * needs it, after each start.sh passes. Returns the names of the runtimes it
 * staged.
 */
export async function stageBoxCodeZip(
  project: Project,
  networks: readonly BoxNetwork[],
  box: () => Promise<BoxLinuxBuild>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter(
    (runtime) => runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint),
  );
  if (runtimes.length === 0) return [];
  const staged = runtimes.map((runtime) => ({
    runtime: runtime.name,
    dist: posix.join(runtime.codeLocation, BOX_CODEZIP_DIST),
  }));
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
  });
  const filesOf = (dist: string) => files.filter(({ path }) => path.startsWith(`${dist}/`));
  for (const runtime of runtimes) {
    assertStartScriptCopiesPolicyFiles(
      join(project.rootPath, runtime.codeLocation, "start.sh"),
      runtime.name,
      networks.find((network) => network.runtime === runtime.name)?.policyFiles ?? [],
    );
  }
  const build = await box();

  for (const { runtime, dist } of staged) {
    const entry = runtimes.find(({ name }) => name === runtime)!;
    const folder = join(project.rootPath, ...dist.split("/"));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const binary of BOX_BINARIES) {
      copyFileSync(join(build.binaries, binary), join(folder, binary));
      chmodSync(join(folder, binary), 0o755);
    }
    cpSync(build.resources, join(folder, "resources"), { recursive: true });
    const ffi = entry.runtimeVersion ? build.ffi[entry.runtimeVersion] : undefined;
    if (ffi) cpSync(ffi, join(folder, "ffi"), { recursive: true });
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
  }
  return runtimes.map((runtime) => runtime.name);
}
