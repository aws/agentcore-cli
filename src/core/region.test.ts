import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGION, regionFlagFromArgv, regionFromConfigFile, resolveRegion } from "./region";

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

const folders: string[] = [];
afterEach(() => Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true }))));

/** A new folder that afterEach removes. */
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentcore-region-"));
  folders.push(path);
  return path;
}

/** An AWS config file with `text`, in a new folder. */
async function configFile(text: string): Promise<string> {
  const path = join(await folder(), "config");
  await writeFile(path, text);
  return path;
}

/** A home folder whose ~/.aws/config holds `text`. */
async function homeWithConfig(text: string): Promise<string> {
  const home = await folder();
  await mkdir(join(home, ".aws"));
  await writeFile(join(home, ".aws", "config"), text);
  return home;
}

const CONFIG = "[default]\nregion = us-east-1\n\n[profile work]\nregion = eu-west-2\n";

describe("regionFromConfigFile", () => {
  test("returns undefined when the config file lacks the profile's region", async () => {
    const config = await configFile(
      "[profile other]\nregion = eu-west-1\n\n[default]\noutput = json\n",
    );

    expect(await regionFromConfigFile({ AWS_CONFIG_FILE: config })).toBeUndefined();
  });

  test("reads the default profile of the AWS_CONFIG_FILE of the environment it is given", async () => {
    const config = await configFile(CONFIG);

    expect(await regionFromConfigFile({ AWS_CONFIG_FILE: config })).toBe("us-east-1");
  });

  test("reads the AWS_PROFILE of the environment it is given", async () => {
    const config = await configFile(CONFIG);

    expect(await regionFromConfigFile({ AWS_CONFIG_FILE: config, AWS_PROFILE: "work" })).toBe(
      "eu-west-2",
    );
  });

  test("reads none of AWS_CONFIG_FILE, AWS_PROFILE, and the home folder from process.env", async () => {
    const saved = { ...process.env };
    try {
      process.env.AWS_CONFIG_FILE = await configFile("[profile work]\nregion = ap-south-1\n");
      process.env.AWS_PROFILE = "work";
      process.env.HOME = await homeWithConfig("[default]\nregion = ap-south-1\n");
      const home = await homeWithConfig("[default]\nregion = sa-east-1\n");

      expect(await regionFromConfigFile({ HOME: home })).toBe("sa-east-1");
    } finally {
      for (const name of ["AWS_CONFIG_FILE", "AWS_PROFILE", "HOME"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test.each(["HOME", "USERPROFILE"] as const)(
    "reads ~/.aws/config under the %s of the environment it is given",
    async (variable) => {
      const home = await homeWithConfig("[default]\nregion = eu-west-2\n");

      expect(await regionFromConfigFile({ [variable]: home })).toBe("eu-west-2");
    },
  );

  test("takes HOME over USERPROFILE", async () => {
    const home = await homeWithConfig("[default]\nregion = eu-west-2\n");
    const profile = await homeWithConfig("[default]\nregion = us-east-2\n");

    expect(await regionFromConfigFile({ HOME: home, USERPROFILE: profile })).toBe("eu-west-2");
  });
});

describe("resolveRegion", () => {
  test("takes the flag, then AWS_REGION, AWS_DEFAULT_REGION, and the config file", async () => {
    const env = {
      AWS_REGION: "us-east-2",
      AWS_DEFAULT_REGION: "eu-central-1",
      AWS_CONFIG_FILE: await configFile(CONFIG),
    };

    expect(await resolveRegion("ap-northeast-1", env)).toBe("ap-northeast-1");
    expect(await resolveRegion(undefined, env)).toBe("us-east-2");
    expect(await resolveRegion(undefined, { ...env, AWS_REGION: undefined })).toBe("eu-central-1");
    expect(await resolveRegion(undefined, { AWS_CONFIG_FILE: env.AWS_CONFIG_FILE })).toBe(
      "us-east-1",
    );
  });

  test("falls back to DEFAULT_REGION when the environment names no region", async () => {
    expect(await resolveRegion(undefined, { HOME: await folder() })).toBe(DEFAULT_REGION);
  });
});
