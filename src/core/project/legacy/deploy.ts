import { runInheritedProcess, type InheritedProcessRunner } from "../../../io";

export const V0_CLI_PACKAGE = "@aws/agentcore@0";

export type V0DeployInput = {
  projectRoot: string;
  target: string;
  yes: boolean;
  json: boolean;
};

/** Injectable boundary used by direct deploy and harness dev. */
export type V0DeployRunner = (input: V0DeployInput) => Promise<number>;

/** Run the final v0 deploy implementation with full ownership of the terminal. */
export async function executeV0Deploy(
  input: V0DeployInput,
  runner: InheritedProcessRunner = runInheritedProcess,
): Promise<number> {
  // v0 has no --region flag -- it resolves region per target from
  // aws-targets.json, falling back to AWS_REGION/AWS_DEFAULT_REGION or the AWS
  // config file. Don't forward one: process.env below already carries through
  // whatever AWS_REGION the user has set, and forcing a different value here
  // would outrank v0's own (more correct) profile-aware fallback.
  const args = [
    "npx",
    "--yes",
    V0_CLI_PACKAGE,
    "deploy",
    "--target",
    input.target,
    ...(input.yes ? ["--yes"] : []),
    ...(input.json ? ["--json"] : []),
  ];
  return runner(args, {
    cwd: input.projectRoot,
    env: {
      ...process.env,
      AGENTCORE_SKIP_CONFLICT_CHECK: "1",
    },
  });
}

export const runV0Deploy: V0DeployRunner = (input) => executeV0Deploy(input);
