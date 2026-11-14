import { readFileSync } from "node:fs";
import { ProjectStateError } from "../../../errors/errors";
import { isFile } from "../runtimeBuild";
import { BOX_PROFILE_FILE } from "../templates/boxProfile";

/** The function of a start.sh that copies the profile's policy files to where box reads them. */
const START_SCRIPT_COPIES_POLICY_FILES = "copy_policy_files";

/** A `COPY` of the whole staged folder, which takes the policy files in with the profile. */
const COPIES_WHOLE_DIST = /^\s*COPY\s+(?:--\S+\s+)*\.box-dist\/?\s/m;

/**
 * Throws when the runtime's start.sh cannot carry `policyFiles`: one from an older template fills
 * the profile in another folder and copies none, so box would refuse the profile on AgentCore
 * Runtime, and start.sh would serve the agent without box. A runtime with no start.sh gets no check.
 */
export function assertStartScriptCopiesPolicyFiles(
  startScript: string,
  runtimeName: string,
  policyFiles: readonly string[],
): void {
  if (policyFiles.length === 0 || !isFile(startScript)) return;
  if (readFileSync(startScript, "utf8").includes(START_SCRIPT_COPIES_POLICY_FILES)) return;
  throw new ProjectStateError(
    `runtime "${runtimeName}": ${startScript} copies no policy file of ${BOX_PROFILE_FILE} ` +
      `(${policyFiles.join(", ")}). Box would refuse the AgentCore Runtime profile, and start.sh ` +
      "would serve the agent without box. Replace start.sh with the one a new `agentcore create` " +
      "project has, then retry.",
  );
}

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
      "image. Box would refuse its profile there, and start.sh would serve the agent without " +
      "box. Copy it with `COPY .box-dist/ /opt/box/`, as the Dockerfile of a new " +
      "`agentcore create` project does, then retry.",
  );
}
