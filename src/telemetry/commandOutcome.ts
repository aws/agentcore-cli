import { AgentCoreCLIError, LegacyDeployWarningExit } from "../errors";

/** The v0 deployer uses exit 2 after a successful deploy with post-deploy warnings. */
export function shouldRecordCommandFailure(error: AgentCoreCLIError): boolean {
  return error.exitCode !== 0 && !(error instanceof LegacyDeployWarningExit);
}
