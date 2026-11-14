import { existsSync } from "node:fs";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { isFile } from "../runtimeBuild";

/**
 * The box release a container image installs at build time: its Dockerfile downloads the Linux
 * arm64 archive of this version from the GitHub release and checks it against the SHA-256 pinned
 * here, not against the release's SHA256SUMS.txt, so a changed asset fails the build.
 */
export const BOX_RELEASE = {
  repo: "mquang-amazon/staging-boxy",
  version: "0.1.11-linux-preview.2",
  box: { sha256: "31605fd1c6e8d2d31e0222e3612ea978dc65c0c369e8a97e964bf848b460122c" },
} as const;

/**
 * The BuildKit secret that holds a GitHub token able to read the box release: a box image's
 * Dockerfile reads it with `RUN --mount=type=secret,id=gh_token`. On deploy CodeBuild reads it
 * from the Secrets Manager secret `BOX_GITHUB_TOKEN_SECRET`; under dev it is your GitHub login.
 */
export const BOX_GITHUB_TOKEN_SECRET_ID = "gh_token";
export const BOX_GITHUB_TOKEN_SECRET = "agentcore/box/github-token";

/** box and the two helper programs it runs, which must sit beside it. */
export const BOX_BINARIES = [
  "box",
  "strands-box-sock-alias",
  "strands-box-contain-trampoline",
] as const;

/** The Python whose `_ctypes` the ffi shim of a box build replaces. */
const FFI_RUNTIME_VERSION = "PYTHON_3_14";

/** A Linux arm64 box for AgentCore Runtime, and the Python ffi shims, by runtimeVersion. */
export type BoxLinuxBuild = {
  /** The folder that holds box and its helpers. */
  binaries: string;
  /** box's packs. */
  resources: string;
  /** The `_ctypes` and libffi that Box Core's W^X filter allows, for each Python it is built for. */
  ffi: Partial<Record<string, string>>;
};

/** The Amazon Linux 2023 build in the staging-boxy checkout that AGENTCORE_BOX_SOURCE names. */
const SOURCE_BUILD = join("target-al2023", "release");
const SOURCE_FFI = join("target-al2023", "ffi");

/**
 * The box a CodeZip zip carries to AgentCore Runtime: the Amazon Linux 2023 build in the
 * staging-boxy checkout AGENTCORE_BOX_SOURCE names, its packs, and its ffi shim when it has one. A
 * container image installs box itself, from its Dockerfile, so only CodeZip runtimes use this.
 */
export async function resolveBoxLinuxBuild(env: NodeJS.ProcessEnv): Promise<BoxLinuxBuild> {
  const source = env.AGENTCORE_BOX_SOURCE;
  if (!source) {
    throw new InvalidEnvironmentError(
      "a CodeZip runtime runs its agent in a box, so deploy ships box, built for AgentCore " +
        "Runtime. Set AGENTCORE_BOX_SOURCE to the staging-boxy checkout that holds it in " +
        `${SOURCE_BUILD}.`,
    );
  }
  const binaries = join(source, SOURCE_BUILD);
  for (const binary of BOX_BINARIES) {
    if (!isFile(join(binaries, binary))) {
      throw new InvalidEnvironmentError(
        `AGENTCORE_BOX_SOURCE has no ${join(binaries, binary)}. Build box on Amazon Linux 2023 ` +
          `into ${SOURCE_BUILD} there, then retry.`,
      );
    }
  }
  const resources = join(source, "resources");
  if (!existsSync(resources)) {
    throw new InvalidEnvironmentError(`AGENTCORE_BOX_SOURCE has no box packs at ${resources}.`);
  }
  const ffi = join(source, SOURCE_FFI);
  return { binaries, resources, ffi: existsSync(ffi) ? { [FFI_RUNTIME_VERSION]: ffi } : {} };
}
