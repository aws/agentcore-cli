import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import type { Project } from "../../../handlers/project/types";
import { isFile } from "../runtimeBuild";
import {
  BOX_CODEZIP_DIST,
  renderRuntimeBoxProfile,
  runsBoxStartScript,
} from "../templates/boxProfile";

/** box and the two helper programs it runs, which must sit beside it. */
const BOX_BINARIES = ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"] as const;

/**
 * The AgentCore Runtime build of box, under AGENTCORE_BOX_SOURCE: built on
 * Amazon Linux 2023, so it links the Runtime's glibc 2.34.
 */
const RUNTIME_BUILD = join("target-al2023", "release");

/** The _ctypes and libffi that Box Core's W^X filter allows, under AGENTCORE_BOX_SOURCE. */
const RUNTIME_FFI = join("target-al2023", "ffi");

/**
 * Stages box into each CodeZip runtime whose entry point is the box start
 * script, so the zip carries it: `<codeLocation>/.box-dist/` gets box, its
 * helpers, its packs, the libffi shim when there is one, and the Runtime
 * profile, rendered from agentcore.json. The folder is rewritten on every
 * build and deploy. Returns the names of the runtimes it staged.
 *
 * box comes from AGENTCORE_BOX_SOURCE, a staging-boxy checkout with an Amazon
 * Linux 2023 build in target-al2023/, until box ships a Linux release.
 */
export function stageBoxCodeZip(project: Project, env: NodeJS.ProcessEnv): string[] {
  const runtimes = project.spec.runtimes.filter(
    (runtime) => runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint),
  );
  if (runtimes.length === 0) return [];

  const source = env.AGENTCORE_BOX_SOURCE;
  if (!source) {
    throw new InvalidEnvironmentError(
      `runtime "${runtimes[0]!.name}" runs its agent in a box, so deploy ships box, built for ` +
        "AgentCore Runtime. Set AGENTCORE_BOX_SOURCE to the staging-boxy checkout that holds it " +
        `in ${RUNTIME_BUILD}.`,
    );
  }
  const binaries = join(source, RUNTIME_BUILD);
  for (const binary of BOX_BINARIES) {
    if (!isFile(join(binaries, binary))) {
      throw new InvalidEnvironmentError(
        `AGENTCORE_BOX_SOURCE has no ${join(binaries, binary)}. Build box on Amazon Linux 2023 ` +
          `into ${RUNTIME_BUILD} there, then retry.`,
      );
    }
  }
  const resources = join(source, "resources");
  if (!existsSync(resources)) {
    throw new InvalidEnvironmentError(`AGENTCORE_BOX_SOURCE has no box packs at ${resources}.`);
  }
  const ffi = join(source, RUNTIME_FFI);

  for (const runtime of runtimes) {
    const dist = join(project.rootPath, runtime.codeLocation, BOX_CODEZIP_DIST);
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    for (const binary of BOX_BINARIES) {
      copyFileSync(join(binaries, binary), join(dist, binary));
      chmodSync(join(dist, binary), 0o755);
    }
    cpSync(resources, join(dist, "resources"), { recursive: true });
    if (existsSync(ffi)) cpSync(ffi, join(dist, "ffi"), { recursive: true });
    writeFileSync(join(dist, "profile.toml"), renderRuntimeBoxProfile(project.spec, runtime));
  }
  return runtimes.map((runtime) => runtime.name);
}
