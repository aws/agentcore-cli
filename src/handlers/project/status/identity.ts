import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { AwsCredentialSource, AwsIdentity } from "../types";

/** Names where the credentials come from, e.g. "profile dev". */
export function credentialSourceLabel(source: AwsCredentialSource): string {
  return source.credentialSource === "environment"
    ? "credentials from environment variables"
    : `profile ${source.profile}`;
}

/** One line naming the active account and its credential source, or why it is unknown. */
export function awsIdentitySummary(identity: AwsIdentity): string {
  const source = credentialSourceLabel(identity);
  return identity.success
    ? `AWS account ${identity.account} (${source})`
    : `AWS account unavailable (${source}): ${identity.error}`;
}

/** Whether the active credentials belong to another account than the target's. */
export function isAccountMismatch(identity: AwsIdentity, target: AwsDeploymentTarget): boolean {
  return identity.success && identity.account !== target.account;
}

export function accountMismatchWarning(account: string, target: AwsDeploymentTarget): string {
  return (
    `The active AWS credentials belong to account ${account}, ` +
    `but target '${target.name}' is configured for account ${target.account}.`
  );
}
