import { readFileSync } from "node:fs";
import { ProjectStateError } from "../../../errors/errors";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import {
  boxNetworkEdits,
  runtimeProfileWriter,
  writeBoxNetworkFiles,
  writeRenderedBoxFiles,
  type StagedRuntime,
} from "../boxNetworkWriters";
import { boxLocalProfileFile } from "../templates/boxProfile";

/**
 * What the runtime profile writer writes from each runtime's Box network model for the runtimes of
 * `staged`, with the function that writes one runtime's files into its staged folder and a copy
 * into its `.box/<name>/aws/`.
 */
export function stagedRuntimeProfiles(
  project: Project,
  networks: readonly BoxNetwork[],
  staged: readonly StagedRuntime[],
): (runtime: StagedRuntime) => void {
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
    envLocal: {},
  });
  return ({ runtime, dist }) => {
    const own = files.filter(({ path }) => path.startsWith(`${dist}/`));
    writeBoxNetworkFiles(project.rootPath, own);
    writeRenderedBoxFiles(project.rootPath, runtime, dist, own);
  };
}

/** A `COPY` of the whole staged folder, which takes the policy files in with the profile. */
const COPIES_WHOLE_DIST = /^\s*COPY\s+(?:--\S+\s+)*(?:\.box-dist|\$\{BOX_DIST\})\/?\s/m;

/**
 * Throws when policy files go to AgentCore Runtime but the Dockerfile copies only named files of
 * `.box-dist/`: then the image has no policy file, so box refuses its profile.
 */
export function assertImageCopiesPolicyFiles(
  dockerfile: string,
  runtimeName: string,
  policyFiles: readonly string[],
): void {
  if (policyFiles.length === 0 || COPIES_WHOLE_DIST.test(readFileSync(dockerfile, "utf8"))) return;
  throw new ProjectStateError(
    `runtime "${runtimeName}" takes the policy files of ${boxLocalProfileFile(runtimeName)} to AgentCore Runtime ` +
      `(${policyFiles.join(", ")}), but ${dockerfile} does not copy .box-dist/ whole into the ` +
      "image. Box would refuse its profile there. Copy the box steps of the Dockerfile of a new " +
      "`agentcore create --template agent-python-strands-box-container` project: they copy " +
      "the whole folder beside the profile, and move its packs beside box. Then retry.",
  );
}
