import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootHandler } from "../handlers";
import { TestCoreClient, testExecutionPolicy, testIO } from "../testing";

// writeConfigFile writes an AWS shared-config file with the given contents to a
// fresh temp dir and returns its path, for exercising the config-file region tier.
function writeConfigFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-aws-"));
  const path = join(dir, "config");
  writeFileSync(path, contents);
  return path;
}

// Region resolution is observable behavior: whatever region withRegion settles
// on is the region the command's Core call actually uses. Rather than reaching
// into the middleware, these tests route a real command and read the region off
// the recorded Core call — precedence is asserted through its effect.

// resolvedRegion routes `harness list` (with `--json` so it prints instead of
// opening the TUI) and returns the region the handler passed to Core.
async function resolvedRegion(args: string[]): Promise<string> {
  const core = new TestCoreClient();
  const root = createRootHandler(core, testIO().io);
  await root.route(
    ["node", "agentcore", "harness", "list", "--json", ...args],
    testExecutionPolicy(),
  );
  const call = core.harness.calls.at(-1);
  const options = call?.args[2] as { region: string };
  return options.region;
}

// Snapshot and restore the AWS_* env so tests don't leak into each other or
// depend on the developer's shell.
const SAVED = {
  AWS_REGION: process.env.AWS_REGION,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  AWS_PROFILE: process.env.AWS_PROFILE,
  AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
};

function clearAwsEnv() {
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  delete process.env.AWS_PROFILE;
  // Point at a nonexistent config file so the shared-config fallback resolves to
  // nothing regardless of the developer's ~/.aws/config.
  process.env.AWS_CONFIG_FILE = "/nonexistent/aws/config";
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("region resolution precedence", () => {
  test("an explicit --region wins over everything", async () => {
    clearAwsEnv();
    process.env.AWS_REGION = "eu-west-1";
    expect(await resolvedRegion(["--region", "ap-south-1"])).toBe("ap-south-1");
  });

  test("falls back to AWS_REGION when no flag is given", async () => {
    clearAwsEnv();
    process.env.AWS_REGION = "eu-west-1";
    expect(await resolvedRegion([])).toBe("eu-west-1");
  });

  test("falls back to AWS_DEFAULT_REGION when AWS_REGION is unset", async () => {
    clearAwsEnv();
    process.env.AWS_DEFAULT_REGION = "sa-east-1";
    expect(await resolvedRegion([])).toBe("sa-east-1");
  });

  test("falls back to the shared config file's default profile", async () => {
    clearAwsEnv();
    process.env.AWS_CONFIG_FILE = writeConfigFile("[default]\nregion = ca-central-1\n");
    expect(await resolvedRegion([])).toBe("ca-central-1");
  });

  test("reads the region for the active named profile (AWS_PROFILE)", async () => {
    clearAwsEnv();
    process.env.AWS_CONFIG_FILE = writeConfigFile(
      "[default]\nregion = ca-central-1\n\n[profile work]\nregion = eu-central-1\n",
    );
    process.env.AWS_PROFILE = "work";
    expect(await resolvedRegion([])).toBe("eu-central-1");
  });

  test("env AWS_REGION wins over the shared config file", async () => {
    clearAwsEnv();
    process.env.AWS_CONFIG_FILE = writeConfigFile("[default]\nregion = ca-central-1\n");
    process.env.AWS_REGION = "us-west-1";
    expect(await resolvedRegion([])).toBe("us-west-1");
  });

  test("falls back to us-east-1 when nothing is configured", async () => {
    clearAwsEnv();
    expect(await resolvedRegion([])).toBe("us-east-1");
  });
});
