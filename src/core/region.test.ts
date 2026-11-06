import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { activeCredentialSource, activeProfile, regionFlagFromArgv } from "./region";

describe("regionFlagFromArgv", () => {
  test("extracts --region <value>", () => {
    expect(regionFlagFromArgv(["node", "agentcore", "deploy", "--region", "cn-north-1"])).toBe(
      "cn-north-1",
    );
  });

  test("extracts --region=<value>", () => {
    expect(regionFlagFromArgv(["node", "agentcore", "--region=us-west-2", "status"])).toBe(
      "us-west-2",
    );
  });

  test("returns undefined without the flag", () => {
    expect(regionFlagFromArgv(["node", "agentcore", "status"])).toBeUndefined();
  });

  test("returns undefined for a trailing bare --region", () => {
    expect(regionFlagFromArgv(["node", "agentcore", "--region"])).toBeUndefined();
  });
});

describe("regionFromConfigFile", () => {
  test("returns undefined when the config file lacks the profile's region", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "agentcore-region-"));
    const savedConfigFile = process.env.AWS_CONFIG_FILE;
    const savedProfile = process.env.AWS_PROFILE;
    try {
      const path = join(dir, "config");
      await writeFile(path, "[profile other]\nregion = eu-west-1\n\n[default]\noutput = json\n");
      process.env.AWS_CONFIG_FILE = path;
      delete process.env.AWS_PROFILE;
      const { regionFromConfigFile } = await import("./region");
      expect(await regionFromConfigFile()).toBeUndefined();
    } finally {
      if (savedConfigFile === undefined) delete process.env.AWS_CONFIG_FILE;
      else process.env.AWS_CONFIG_FILE = savedConfigFile;
      if (savedProfile === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = savedProfile;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("activeCredentialSource", () => {
  const names = ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of names) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("falls back to the default profile", () => {
    expect(activeProfile()).toBe("default");
    expect(activeCredentialSource()).toEqual({ credentialSource: "profile", profile: "default" });
  });

  test("treats an empty AWS_PROFILE as unset", () => {
    process.env.AWS_PROFILE = "";
    expect(activeCredentialSource()).toEqual({ credentialSource: "profile", profile: "default" });
  });

  test("reports environment credentials when a key pair is set without AWS_PROFILE", () => {
    process.env.AWS_ACCESS_KEY_ID = "access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
    expect(activeCredentialSource()).toEqual({ credentialSource: "environment" });
  });

  test("ignores an access key without its secret", () => {
    process.env.AWS_ACCESS_KEY_ID = "access-key";
    expect(activeCredentialSource()).toEqual({ credentialSource: "profile", profile: "default" });
  });

  test("prefers AWS_PROFILE over environment keys, as the SDK's default chain does", () => {
    process.env.AWS_PROFILE = "dev";
    process.env.AWS_ACCESS_KEY_ID = "access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
    expect(activeCredentialSource()).toEqual({ credentialSource: "profile", profile: "dev" });
  });
});
