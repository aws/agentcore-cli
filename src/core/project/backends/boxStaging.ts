import { readFileSync } from "node:fs";
import { ProjectStateError } from "../../../errors/errors";
import { BOX_PROFILE_FILE } from "../templates/boxProfile";

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
    `runtime "${runtimeName}" takes the policy files of ${BOX_PROFILE_FILE} to AgentCore Runtime ` +
      `(${policyFiles.join(", ")}), but ${dockerfile} does not copy .box-dist/ whole into the ` +
      "image. Box would refuse its profile there. Copy it with " +
      "`COPY ${BOX_DIST}/ /home/bedrock_agentcore/box-profile/`, as the Dockerfile of a new " +
      "`agentcore create` project does, then retry.",
  );
}
