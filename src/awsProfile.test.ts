import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsProfileEnvironment, selectedAwsProfile, withAwsProfile } from "./awsProfile";
import { CoreClient } from "./core";
import * as factories from "./core/factories";
import { createSilentLogger } from "./testing";
import { runProcess } from "./io";
import { createCdkIoHost, resolveCdkCredentials } from "./core/project/backends/cdk/toolkit";
import { resolveAwsAccount } from "./core/project/backends/cdk/environment";

const keys = [
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;
let saved: NodeJS.ProcessEnv;
let directory: string;
beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  directory = await mkdtemp(join(tmpdir(), "agentcore-profile-"));
  process.env.AWS_CONFIG_FILE = join(directory, "config");
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(directory, "credentials");
  process.env.AWS_PROFILE = "ambient";
  process.env.AWS_ACCESS_KEY_ID = "environment-key";
  process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
  await writeFile(
    process.env.AWS_CONFIG_FILE,
    "[profile first]\nregion = eu-west-1\n[profile second]\nregion = ap-south-1\n",
  );
  await writeFile(
    process.env.AWS_SHARED_CREDENTIALS_FILE,
    "[first]\naws_access_key_id = first-key\naws_secret_access_key = first-secret\n" +
      "[second]\naws_access_key_id = second-key\naws_secret_access_key = second-secret\n",
  );
});
afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});

describe("explicit AWS profiles", () => {
  test("selects profile credentials over ambient profile and static environment keys", async () => {
    await withAwsProfile("first", async () => {
      expect((await selectedAwsProfile()!.credentials()).accessKeyId).toBe("first-key");
    });
    expect(process.env.AWS_PROFILE).toBe("ambient");
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("environment-key");
    expect(selectedAwsProfile()).toBeUndefined();
  });

  test("an unknown profile cannot fall back to environment credentials", async () => {
    await expect(
      withAwsProfile("missing", () => selectedAwsProfile()!.credentials()),
    ).rejects.toThrow();
    expect(selectedAwsProfile()).toBeUndefined();
  });

  test("loads temporary credentials from a credential_process profile", async () => {
    const script = join(directory, "credentials.cjs");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: "process-key", SecretAccessKey: "process-secret", SessionToken: "process-token", Expiration: "2099-01-01T00:00:00Z" }));`,
    );
    await writeFile(
      process.env.AWS_CONFIG_FILE!,
      `[profile process]\ncredential_process = "${process.execPath}" "${script}"\n`,
    );
    await withAwsProfile("process", async () => {
      expect(await selectedAwsProfile()!.credentials()).toMatchObject({
        accessKeyId: "process-key",
        secretAccessKey: "process-secret",
        sessionToken: "process-token",
      });
    });
  });

  test("STS account lookup signs with the selected profile and honors explicit credentials", async () => {
    const authorization: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization.push(request.headers.get("authorization") ?? "");
        return new Response(
          '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>',
          { headers: { "content-type": "text/xml" } },
        );
      },
    });
    const savedEndpoint = process.env.AWS_ENDPOINT_URL_STS;
    process.env.AWS_ENDPOINT_URL_STS = `http://localhost:${server.port}`;
    try {
      await withAwsProfile("first", async () => {
        expect(await resolveAwsAccount("us-east-1")).toBe("123456789012");
        expect(
          await resolveAwsAccount("us-east-1", async () => ({
            accessKeyId: "target-key",
            secretAccessKey: "target-secret",
          })),
        ).toBe("123456789012");
      });
      expect(authorization[0]).toContain("Credential=first-key/");
      expect(authorization[1]).toContain("Credential=target-key/");
    } finally {
      if (savedEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_STS;
      else process.env.AWS_ENDPOINT_URL_STS = savedEndpoint;
      server.stop(true);
    }
  });

  test("nested and concurrent commands retain their own selection", async () => {
    await withAwsProfile("first", async () => {
      await expect(
        withAwsProfile("second", async () => {
          expect(selectedAwsProfile()!.name).toBe("second");
          throw new Error("command failed");
        }),
      ).rejects.toThrow("command failed");
      expect(selectedAwsProfile()!.name).toBe("first");
    });
    const credentials = await Promise.all(
      ["first", "second"].map((name) =>
        withAwsProfile(name, async () => {
          await Promise.resolve();
          expect(selectedAwsProfile()!.name).toBe(name);
          return (await selectedAwsProfile()!.credentials()).accessKeyId;
        }),
      ),
    );
    expect(credentials).toEqual(["first-key", "second-key"]);
    expect(selectedAwsProfile()).toBeUndefined();
  });

  test("SDK caches distinguish profiles and preserve explicit target credentials", async () => {
    const core = new CoreClient({ ...factories, logger: createSilentLogger() });
    const first = await withAwsProfile("first", async () => {
      const client = core.control({ region: "us-east-1" });
      expect(core.control({ region: "us-east-1" })).toBe(client);
      expect((await client.config.credentials()).accessKeyId).toBe("first-key");
      return client;
    });
    await withAwsProfile("second", async () => {
      const client = core.control({ region: "us-east-1" });
      expect(client).not.toBe(first);
      expect((await client.config.credentials()).accessKeyId).toBe("second-key");
      const target = core.control({
        region: "us-east-1",
        credentials: { accessKeyId: "target-key", secretAccessKey: "target-secret" },
      });
      expect((await target.config.credentials()).accessKeyId).toBe("target-key");
      const deploymentProvider = await resolveCdkCredentials(
        createCdkIoHost(createSilentLogger()),
        "us-east-1",
      );
      expect(deploymentProvider).toBe(selectedAwsProfile()!.credentials);
      expect((await deploymentProvider()).accessKeyId).toBe("second-key");
    });
  });

  test("child tools receive the profile without inherited static credentials", async () => {
    let output = "";
    await withAwsProfile("first", () =>
      runProcess(
        [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({profile:process.env.AWS_PROFILE,defaultProfile:process.env.AWS_DEFAULT_PROFILE,key:process.env.AWS_ACCESS_KEY_ID,token:process.env.AWS_SESSION_TOKEN,marker:process.env.MARKER}))",
        ],
        {
          cwd: directory,
          env: { ...process.env, AWS_SESSION_TOKEN: "ambient-token", MARKER: "retained" },
          onOutput: (chunk) => {
            output += chunk;
          },
        },
      ),
    );
    expect(JSON.parse(output)).toEqual({
      profile: "first",
      defaultProfile: "first",
      marker: "retained",
    });
    const ambient = { AWS_PROFILE: "ambient", AWS_ACCESS_KEY_ID: "ambient-key" };
    expect(awsProfileEnvironment(ambient)).toBe(ambient);
  });
});
