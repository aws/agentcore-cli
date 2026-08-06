import { describe, expect, test } from "bun:test";
import {
  BUILD_MANIFEST_PATH,
  BUILD_MANIFEST_VERSION,
  BuildManifestSchema,
  BuildResultSchema,
  type BuildManifest,
} from "./buildManifest";

function manifest(overrides: Partial<BuildManifest> = {}): BuildManifest {
  return {
    manifestVersion: BUILD_MANIFEST_VERSION,
    projectName: "MyAgent",
    cliVersion: "1.0.0",
    inputFingerprint: "a".repeat(64),
    builtAt: "2026-08-06T12:34:56.000Z",
    targets: [
      {
        name: "development",
        account: "123456789012",
        region: "us-east-1",
      },
    ],
    artifact: {
      kind: "cdk-cloud-assembly",
      path: "agentcore/cdk/cdk.out",
      stacksByTarget: {
        development: "MyAgent-development",
      },
    },
    ...overrides,
  };
}

describe("BuildResultSchema", () => {
  test("returns the manifest and its canonical path", () => {
    const builtManifest = manifest();
    const result = BuildResultSchema.parse({
      manifestPath: BUILD_MANIFEST_PATH,
      manifest: builtManifest,
    });

    expect(result.manifestPath).toBe(BUILD_MANIFEST_PATH);
    expect(result.manifest).toEqual(builtManifest);
  });

  test("rejects a non-canonical manifest path", () => {
    expect(
      BuildResultSchema.safeParse({
        manifestPath: "manifest.json",
        manifest: manifest(),
      }).success,
    ).toBe(false);
  });
});

describe("BuildManifestSchema", () => {
  test("accepts a CDK artifact and records the canonical manifest path", () => {
    const parsed = BuildManifestSchema.parse(manifest());

    expect(parsed.artifact).toEqual({
      kind: "cdk-cloud-assembly",
      path: "agentcore/cdk/cdk.out",
      stacksByTarget: {
        development: "MyAgent-development",
      },
    });
    expect(BUILD_MANIFEST_PATH).toBe("agentcore/.build/manifest.json");
  });

  test("requires every deployment target to have exactly one synthesized stack", () => {
    const missing = manifest({
      targets: [
        {
          name: "development",
          account: "123456789012",
          region: "us-east-1",
        },
        {
          name: "production",
          account: "210987654321",
          region: "us-west-2",
        },
      ],
    });
    const extra = manifest({
      artifact: {
        kind: "cdk-cloud-assembly",
        path: "agentcore/cdk/cdk.out",
        stacksByTarget: {
          development: "MyAgent-development",
          unused: "MyAgent-unused",
        },
      },
    });

    expect(BuildManifestSchema.safeParse(missing).success).toBe(false);
    expect(BuildManifestSchema.safeParse(extra).success).toBe(false);
  });

  test("rejects duplicate target names", () => {
    const input = manifest({
      targets: [
        {
          name: "development",
          account: "123456789012",
          region: "us-east-1",
        },
        {
          name: "development",
          account: "210987654321",
          region: "us-west-2",
        },
      ],
    });

    expect(BuildManifestSchema.safeParse(input).success).toBe(false);
  });

  test.each([
    "/tmp/cdk.out",
    "../cdk.out",
    "agentcore\\cdk\\cdk.out",
    "C:\\cdk.out",
    "agentcore//cdk.out",
  ])("rejects an artifact path outside the project: %s", (path) => {
    const input = manifest({
      artifact: {
        kind: "cdk-cloud-assembly",
        path,
        stacksByTarget: {
          development: "MyAgent-development",
        },
      },
    });

    expect(BuildManifestSchema.safeParse(input).success).toBe(false);
  });

  test("rejects unknown artifact kinds", () => {
    const input = {
      ...manifest(),
      artifact: {
        kind: "terraform-plan",
        path: "agentcore/terraform/plan.json",
      },
    };

    expect(BuildManifestSchema.safeParse(input).success).toBe(false);
  });
});
