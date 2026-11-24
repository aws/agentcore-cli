import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AwsCredentialIdentity } from "@smithy/types";
import { resolveDefaultAwsCredentials, writeBoxDevAwsFiles } from "./boxAwsCredentials";

const FIRST: AwsCredentialIdentity = {
  accessKeyId: "AKIDFIRST",
  secretAccessKey: "first-secret",
  sessionToken: "first-token",
};
const SECOND: AwsCredentialIdentity = { accessKeyId: "AKIDSECOND", secretAccessKey: "second" };

/** The host path of the file mounted at `container`, from the `-v host:container:ro` flags. */
function hostPath(mounts: string[], container: string): string {
  const flag = mounts.find((value) => value.includes(`:${container}:`));
  if (!flag) throw new Error(`no mount for ${container}`);
  // A Windows host path has its own colon (C:\...), so the host path ends at the container one.
  return flag.slice(0, flag.indexOf(`:${container}:`));
}

describe("writeBoxDevAwsFiles", () => {
  test("writes nothing when no credentials resolve", async () => {
    expect(
      await writeBoxDevAwsFiles(async () => undefined, { AWS_REGION: "us-west-2" }),
    ).toBeUndefined();
  });

  test("refresh rewrites the mounted file in place, and keeps it when nothing resolves", async () => {
    const answers: (AwsCredentialIdentity | undefined | Error)[] = [
      FIRST,
      SECOND,
      undefined,
      new Error("sso expired"),
    ];
    const files = await writeBoxDevAwsFiles(
      async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      { AWS_REGION: "us-west-2" },
    );
    if (!files) throw new Error("expected files");
    try {
      const credentials = hostPath(files.mounts, "/aws-config/credentials");
      expect(readFileSync(credentials, "utf8")).toContain("aws_session_token = first-token");
      const inode = statSync(credentials).ino;

      await files.refresh();
      const second = readFileSync(credentials, "utf8");
      expect(second).toBe(
        "[default]\naws_access_key_id = AKIDSECOND\naws_secret_access_key = second\n",
      );
      expect(statSync(credentials).ino).toBe(inode);

      await files.refresh();
      await expect(files.refresh()).rejects.toThrow("sso expired");
      expect(readFileSync(credentials, "utf8")).toBe(second);
    } finally {
      await files.dispose();
    }
  });

  test("resolves the credentials of the environment the container runs with, and writes its region", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const env = { AWS_PROFILE: "dev-account", AWS_DEFAULT_REGION: "eu-west-1" };
    const files = await writeBoxDevAwsFiles(async (given) => {
      seen.push(given);
      return FIRST;
    }, env);
    if (!files) throw new Error("expected files");
    try {
      await files.refresh();
      // The first write and each refresh resolve the same identity.
      expect(seen).toEqual([env, env]);
      const config = hostPath(files.mounts, "/aws-config/config");
      expect(readFileSync(config, "utf8")).toBe("[default]\nregion = eu-west-1\n");
    } finally {
      await files.dispose();
    }
  });

  test("dispose removes the folder", async () => {
    const files = await writeBoxDevAwsFiles(async () => FIRST, {});
    if (!files) throw new Error("expected files");
    const folder = dirname(hostPath(files.mounts, "/aws-config/config"));
    expect(existsSync(folder)).toBe(true);
    await files.dispose();
    expect(existsSync(folder)).toBe(false);
  });
});

describe("resolveDefaultAwsCredentials", () => {
  test("takes the keys of the container's environment first, as the agent outside a box does", async () => {
    expect(
      await resolveDefaultAwsCredentials({
        AWS_ACCESS_KEY_ID: "AKIDENV",
        AWS_SECRET_ACCESS_KEY: "env-secret",
        AWS_SESSION_TOKEN: "env-token",
        AWS_PROFILE: "ignored-when-keys-are-set",
      }),
    ).toEqual({
      accessKeyId: "AKIDENV",
      secretAccessKey: "env-secret",
      sessionToken: "env-token",
    });
  });

  test("leaves out a session token the environment does not set", async () => {
    expect(
      await resolveDefaultAwsCredentials({
        AWS_ACCESS_KEY_ID: "AKIDENV",
        AWS_SECRET_ACCESS_KEY: "env-secret",
      }),
    ).toEqual({ accessKeyId: "AKIDENV", secretAccessKey: "env-secret" });
  });
});
