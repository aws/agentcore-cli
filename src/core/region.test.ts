import { describe, expect, test } from "bun:test";
import { profileFlagFromArgv, regionFlagFromArgv } from "./region";

test.each([
  { argv: ["--profile", "development"], expected: "development" },
  { argv: ["--profile=development"], expected: "development" },
  { argv: ["--profile=first", "--profile", "last"], expected: "last" },
  { argv: ["--", "--profile", "argument"], expected: undefined },
  { argv: ["--profile"], expected: undefined },
  { argv: [], expected: undefined },
])("extracts the effective profile before command routing: %j", ({ argv, expected }) => {
  expect(profileFlagFromArgv(["node", "agentcore", ...argv])).toBe(expected);
});

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
