import { AsyncLocalStorage } from "node:async_hooks";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@smithy/types";

type SelectedProfile = { name: string; credentials: AwsCredentialIdentityProvider };
const profiles = new AsyncLocalStorage<SelectedProfile>();

/** Keep profile selection local to a command, including its asynchronous work. */
export function withAwsProfile<T>(name: string, action: () => T, region?: string): T {
  return profiles.run(
    { name, credentials: fromIni({ profile: name, clientConfig: { region } }) },
    action,
  );
}

export function selectedAwsProfile(): SelectedProfile | undefined {
  return profiles.getStore();
}

/** Child tools use the selected profile instead of inherited static credentials. */
export function awsProfileEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const profile = selectedAwsProfile();
  if (!profile) return env;
  const selected: NodeJS.ProcessEnv = {
    ...env,
    AWS_PROFILE: profile.name,
    AWS_DEFAULT_PROFILE: profile.name,
  };
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
  ]) {
    delete selected[key];
  }
  return selected;
}
