import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCoreGatewayTargetSchema } from "../../projectSchemas/gateway";
import { boxEgressRoutes, getBoxEgressTargetSpec } from "./boxEgress";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function projectWithProfile(toml: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-egress-"));
  directories.push(root);
  if (toml !== undefined) {
    await mkdir(join(root, ".box"), { recursive: true });
    await writeFile(join(root, ".box", "profile.toml"), toml);
  }
  return root;
}

describe("boxEgressRoutes", () => {
  test("returns no routes when the profile is absent", async () => {
    expect(boxEgressRoutes(await projectWithProfile(undefined))).toEqual([]);
  });

  test("returns a route for each env:// egress that lists destinations", async () => {
    const root = await projectWithProfile(
      '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
    );

    expect(boxEgressRoutes(root)).toEqual([
      {
        name: "github",
        destinations: ["api.github.com"],
        endpoint: "https://api.github.com",
        variable: "GITHUB_TOKEN",
        header: "Authorization",
      },
    ]);
  });

  test("reads the single `destination` form and keeps a URL as the endpoint", async () => {
    const root = await projectWithProfile(
      '[egress.github]\ndestination = "https://www.github.com"\nsecret.ref = "env://GITHUB_TOKEN"\n',
    );

    expect(boxEgressRoutes(root)).toEqual([
      {
        name: "github",
        destinations: ["https://www.github.com"],
        endpoint: "https://www.github.com",
        variable: "GITHUB_TOKEN",
        header: "Authorization",
      },
    ]);
  });

  test("uses secret.header when it is a valid header name", async () => {
    const root = await projectWithProfile(
      '[egress.svc]\ndestinations = ["api.svc.com"]\nsecret.ref = "env://SVC_KEY"\nsecret.header = "x-api-key"\n',
    );

    expect(boxEgressRoutes(root)[0]!.header).toBe("x-api-key");
  });

  test("skips an aws:// ref, a reserved name, an invalid name, and an entry with no destination", async () => {
    const root = await projectWithProfile(
      '[egress.bedrock]\ndestinations = ["bedrock.aws"]\nsecret.ref = "aws://default"\n\n' +
        '[egress.agentcore]\ndestinations = ["a.aws"]\nsecret.ref = "env://A"\n\n' +
        '[egress."not a name"]\ndestinations = ["b.com"]\nsecret.ref = "env://B"\n\n' +
        '[egress.nohost]\nsecret.ref = "env://C"\n',
    );

    expect(boxEgressRoutes(root)).toEqual([]);
  });

  test("returns no routes for a malformed profile", async () => {
    expect(boxEgressRoutes(await projectWithProfile("this is = not [valid toml"))).toEqual([]);
  });
});

describe("getBoxEgressTargetSpec", () => {
  test("builds a passthrough target with API_KEY outbound auth that the schema accepts", () => {
    const target = getBoxEgressTargetSpec({
      name: "github",
      destinations: ["api.github.com"],
      endpoint: "https://api.github.com",
      variable: "GITHUB_TOKEN",
      header: "Authorization",
    });

    expect(target).toEqual({
      name: "github",
      targetType: "passthrough",
      passthrough: { endpoint: "https://api.github.com", protocolType: "CUSTOM" },
      outboundAuth: { type: "API_KEY", credentialName: "github", parameterName: "Authorization" },
    });
    expect(AgentCoreGatewayTargetSchema.safeParse(target).success).toBe(true);
  });
});
