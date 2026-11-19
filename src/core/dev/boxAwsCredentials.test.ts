import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AwsCredentialIdentity } from "@smithy/types";
import { writeBoxDevAwsFiles } from "./boxAwsCredentials";

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
  return flag.slice(0, flag.indexOf(":"));
}

describe("writeBoxDevAwsFiles", () => {
  test("writes nothing when no credentials resolve", async () => {
    expect(await writeBoxDevAwsFiles(async () => undefined, "us-west-2")).toBeUndefined();
  });

  test("refresh rewrites the mounted file in place, and keeps it when nothing resolves", async () => {
    const answers: (AwsCredentialIdentity | undefined | Error)[] = [
      FIRST,
      SECOND,
      undefined,
      new Error("sso expired"),
    ];
    const files = await writeBoxDevAwsFiles(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }, "us-west-2");
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

  test("dispose removes the folder", async () => {
    const files = await writeBoxDevAwsFiles(async () => FIRST, undefined);
    if (!files) throw new Error("expected files");
    const folder = dirname(hostPath(files.mounts, "/aws-config/config"));
    expect(existsSync(folder)).toBe(true);
    await files.dispose();
    expect(existsSync(folder)).toBe(false);
  });
});
