import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
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
 * The AWS CLI v2 for Linux arm64 that a box image installs when its Runtime profile reads a key
 * from AWS Secrets Manager: Box runs `aws` outside the sandbox to read it. The checksum is of the
 * archive at `url`.
 */
export const AWS_CLI_RELEASE = {
  version: "2.41.1",
  url: "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.41.1.zip",
  sha256: "83f3bb8440cf6a05e6289f8024126b8c8e15e9513adfe0d6c059747350cdb1e2",
} as const;

/**
 * The PGP key that signs each AWS CLI installer, as the AWS CLI install guide publishes it, and its
 * fingerprint. The image accepts the archive only with a valid signature made by this key.
 */
export const AWS_CLI_SIGNING_KEY = {
  fingerprint: "FB5DB77FD5C118B80511ADA8A6310ACC4672475C",
  expires: "2027-07-01",
  armored: `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----`,
} as const;

/** The key of `armored` as one base64 line: its packets, the keyring that `gpgv` reads. */
export function keyringBase64(armored: string): string {
  const lines = armored.split("\n").map((line) => line.trim());
  const body = lines.slice(lines.indexOf("") + 1);
  return body
    .slice(
      0,
      body.findIndex((line) => line.startsWith("=")),
    )
    .join("");
}

/** The lines of {@link BOX_RELEASE_ENV} that make the image install {@link AWS_CLI_RELEASE}. */
export function awsCliReleaseEnv(): string {
  return (
    `AWS_CLI_URL=${AWS_CLI_RELEASE.url}\nAWS_CLI_SHA256=${AWS_CLI_RELEASE.sha256}\n` +
    `AWS_CLI_PGP_FINGERPRINT=${AWS_CLI_SIGNING_KEY.fingerprint}\n` +
    `AWS_CLI_PGP_KEYRING=${keyringBase64(AWS_CLI_SIGNING_KEY.armored)}\n`
  );
}

/** Whether the Runtime profile of `network` reads a key from AWS Secrets Manager. */
function readsSecretsManager(network: BoxNetwork | undefined): boolean {
  return (network?.thirdPartyTelemetry ?? []).some(({ secret }) => secret !== undefined);
}

/**
 * Writes `<context>/<folder>` for a box image: `profileText`, the profile the image runs, each
 * policy file of `policies` at its path from the agent's local box folder, and the box release the Dockerfile downloads.
 * The folder is rewritten each time.
 */
export async function stageBoxImage(
  context: string,
  profileText: string,
  policies: readonly PolicyFileCopy[],
  release: BoxRelease,
  folder: string = BOX_IMAGE_DIST,
): Promise<void> {
  const dist = join(context, folder);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "profile.toml"), profileText);
  await writeFile(join(dist, BOX_RELEASE_ENV), boxReleaseEnv(release));
  for (const { from, relative } of policies) {
    const to = join(dist, ...relative.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/**
 * Stages box for build and deploy into each container runtime whose Dockerfile copies `.box-dist/`.
 * It generates the canonical AWS tree in `.box/<name>/aws/`: the box release its `box.version` names
 * (and the AWS CLI, when the Runtime profile reads a key from AWS Secrets Manager),
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
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    const release = await releaseFor(runtime.box?.version);
    const network = networks.find((candidate) => candidate.runtime === runtime.name);
    await writeFile(
      join(folder, BOX_RELEASE_ENV),
      boxReleaseEnv(release) + (readsSecretsManager(network) ? awsCliReleaseEnv() : ""),
    );
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
    // Copy the canonical AWS tree into the build context's .box-dist so the image copies it.
    const contextDist = join(containerBuildContext(project.rootPath, runtime), BOX_IMAGE_DIST);
    await rm(contextDist, { recursive: true, force: true });
    await cp(folder, contextDist, { recursive: true });
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
