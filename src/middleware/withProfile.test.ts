import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootHandler } from "../handlers";
import { createSilentLogger, TestCoreClient, TestGlobalConfigAccessor, testIO } from "../testing";
import type { CoreOptions } from "../core/types";

const keys = [
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;
let saved: NodeJS.ProcessEnv;
let directory: string;
beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  directory = await mkdtemp(join(tmpdir(), "agentcore-profile-route-"));
  process.env.AWS_CONFIG_FILE = join(directory, "config");
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(directory, "credentials");
  process.env.AWS_PROFILE = "ambient";
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  await writeFile(
    process.env.AWS_CONFIG_FILE,
    "[profile chosen]\nregion = eu-west-1\n[profile ambient]\nregion = ap-south-1\n",
  );
  await writeFile(
    process.env.AWS_SHARED_CREDENTIALS_FILE,
    "[chosen]\naws_access_key_id = selected-key\naws_secret_access_key = selected-secret\n",
  );
});
afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});

async function route(args: readonly string[]): Promise<CoreOptions> {
  const core = new TestCoreClient();
  const root = createRootHandler(core, {
    io: testIO().io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args]);
  return core.harness.calls.at(-1)!.args[2] as CoreOptions;
}

test.each([
  { args: ["--profile", "chosen", "harness", "list", "--json"] },
  { args: ["harness", "list", "--json", "--profile", "chosen"] },
  { args: ["harness", "list", "--json", "--profile=chosen"] },
])("global profile works before or after the command: %j", async ({ args }) => {
  const options = await route(args);
  expect(options.region).toBe("eu-west-1");
  expect(
    (await (options.credentials as () => Promise<{ accessKeyId: string }>)()).accessKeyId,
  ).toBe("selected-key");
  expect(process.env.AWS_PROFILE).toBe("ambient");
});

test("region flags and environment retain precedence over the chosen profile", async () => {
  process.env.AWS_REGION = "us-west-2";
  expect((await route(["harness", "list", "--json", "--profile", "chosen"])).region).toBe(
    "us-west-2",
  );
  expect(
    (await route(["harness", "list", "--json", "--profile", "chosen", "--region", "ca-central-1"]))
      .region,
  ).toBe("ca-central-1");
});

test("assume-role profiles use the effective region for STS", async () => {
  await writeFile(
    process.env.AWS_CONFIG_FILE!,
    "[profile role]\nregion = eu-west-1\nrole_arn = arn:aws:iam::123456789012:role/test\nsource_profile = chosen\n",
  );
  let authorization = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization") ?? "";
      return new Response(
        '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>role-key</AccessKeyId><SecretAccessKey>role-secret</SecretAccessKey><SessionToken>role-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>',
        { headers: { "content-type": "text/xml" } },
      );
    },
  });
  const savedEndpoint = process.env.AWS_ENDPOINT_URL_STS;
  process.env.AWS_ENDPOINT_URL_STS = `http://localhost:${server.port}`;
  try {
    const options = await route([
      "harness",
      "list",
      "--json",
      "--profile",
      "role",
      "--region",
      "ca-central-1",
    ]);
    expect(
      (await (options.credentials as () => Promise<{ accessKeyId: string }>)()).accessKeyId,
    ).toBe("role-key");
    expect(authorization).toContain("/ca-central-1/sts/aws4_request");
  } finally {
    if (savedEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_STS;
    else process.env.AWS_ENDPOINT_URL_STS = savedEndpoint;
    server.stop(true);
  }
});

test.each(["", "   "])("rejects an empty profile: %j", async (profile) => {
  await expect(route(["harness", "list", "--json", "--profile", profile])).rejects.toThrow(
    "Profile name must not be empty",
  );
});

test("missing --profile leaves ambient credentials and region behavior unchanged", async () => {
  const options = await route(["harness", "list", "--json"]);
  expect(options.region).toBe("ap-south-1");
  expect(options.credentials).toBeUndefined();
});
