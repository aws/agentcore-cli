import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AwsCredentialIdentity } from "@smithy/types";

/** Resolves the AWS credentials `agentcore dev` hands to box; undefined when there are none. */
export type ResolveAwsCredentials = () => Promise<AwsCredentialIdentity | undefined>;

/**
 * The credentials of the default AWS SDK provider chain, as the CLI's own AWS calls find them:
 * environment variables, the shared files, SSO, or a credential process. Undefined when the chain
 * finds none.
 */
export const resolveDefaultAwsCredentials: ResolveAwsCredentials = async () => {
  const { STSClient } = await import("@aws-sdk/client-sts");
  // The region only satisfies the client; resolving credentials makes no call to it.
  const client = new STSClient({ region: "us-east-1" });
  try {
    return await client.config.credentials();
  } catch {
    return undefined;
  } finally {
    client.destroy();
  }
};

/** Where the dev container finds the AWS files, as AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE name them. */
const CONTAINER_AWS_DIRECTORY = "/aws-config";

/**
 * How often dev rewrites the credentials, so that box keeps signing after temporary credentials
 * expire; ada and SSO credentials last an hour or more.
 */
export const BOX_DEV_AWS_REFRESH_MS = 5 * 60_000;

/** The AWS files a boxed dev container signs with, and the `run` flags and variables that pass them. */
export type BoxDevAwsFiles = {
  /** `-v` flags that mount each file read-only. */
  mounts: string[];
  /** The variables that point the AWS SDK and box at the mounted files. */
  env: Record<string, string>;
  /** Resolves the credentials again and rewrites the file in place; a failure keeps the old ones. */
  refresh(): Promise<void>;
  /** Removes the files. */
  dispose(): Promise<void>;
};

function credentialsText(credentials: AwsCredentialIdentity): string {
  const lines = [
    "[default]",
    `aws_access_key_id = ${credentials.accessKeyId}`,
    `aws_secret_access_key = ${credentials.secretAccessKey}`,
    ...(credentials.sessionToken ? [`aws_session_token = ${credentials.sessionToken}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the resolved AWS credentials as the `[default]` profile that a boxed dev container signs
 * with (`aws://default`), in place of a mount of `~/.aws`. Box in the container runs as the image's
 * user, not as you, so it cannot read a `~/.aws/credentials` that only you may read (mode 0600, the
 * usual case on Linux), and `~/.aws` may not hold the credentials at all (SSO, a credential process,
 * environment variables). The files are readable by any user in the container but sit in a folder
 * that only you may open on the host, and they hold only the current credentials, not every profile
 * in `~/.aws`. Each file is mounted on its own, so a rewrite in place reaches the container.
 * Returns undefined when no credentials resolve.
 */
export async function writeBoxDevAwsFiles(
  resolveCredentials: ResolveAwsCredentials,
  region: string | undefined,
): Promise<BoxDevAwsFiles | undefined> {
  const credentials = await resolveCredentials();
  if (!credentials) return undefined;

  // mkdtemp makes the folder 0700: no other host user can reach the files inside.
  const directory = await mkdtemp(join(tmpdir(), "agentcore-dev-aws-"));
  const credentialsFile = join(directory, "credentials");
  const configFile = join(directory, "config");
  const write = async (path: string, text: string) => {
    await writeFile(path, text);
    await chmod(path, 0o644);
  };
  try {
    await write(credentialsFile, credentialsText(credentials));
    await write(configFile, `[default]\n${region ? `region = ${region}\n` : ""}`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    mounts: [
      "-v",
      `${credentialsFile}:${CONTAINER_AWS_DIRECTORY}/credentials:ro`,
      "-v",
      `${configFile}:${CONTAINER_AWS_DIRECTORY}/config:ro`,
    ],
    env: {
      AWS_CONFIG_FILE: `${CONTAINER_AWS_DIRECTORY}/config`,
      AWS_SHARED_CREDENTIALS_FILE: `${CONTAINER_AWS_DIRECTORY}/credentials`,
    },
    async refresh() {
      const next = await resolveCredentials();
      // writeFile truncates in place, so the file keeps the inode the container mounted.
      if (next) await writeFile(credentialsFile, credentialsText(next));
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
