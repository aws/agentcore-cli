import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FsReadWriteJson } from "../../../../io";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import { createSilentLogger } from "../../../../testing";
import type { WorkloadBuilds } from "../../../../handlers/project/types";
import { assertSupportedBuildTransitions, type DeployedTemplate } from "./localContainers";
import { localImageBuilds } from "./localImages";

// A real assembly synthesized by @aws/agentcore-cdk with Runtime containerUri
// support; see __fixtures__/prebuilt-runtime/README.md.
const FIXTURE = join(import.meta.dir, "__fixtures__", "prebuilt-runtime");
const json = new FsReadWriteJson({ logger: createSilentLogger() });
const template = JSON.parse(
  readFileSync(join(FIXTURE, "AgentCore-Fixture.template.json"), "utf8"),
) as DeployedTemplate & { Resources: Record<string, { Type: string; Properties: any }> };
const spec = JSON.parse(readFileSync(join(FIXTURE, "agentcore.json"), "utf8")) as {
  runtimes: unknown[];
};
const BUILDS: WorkloadBuilds = {
  "runtime/orders": "ContainerLocal",
  "runtime/billing": "Container",
  "runtime/image": "ContainerUri",
  "harness/assistant": "ContainerLocal",
};

describe("a Runtime with containerUri, as the CDK package synthesizes it", () => {
  test("the CLI schema accepts the agentcore.json the fixture was synthesized from", () => {
    for (const runtime of spec.runtimes) {
      expect(ProjectRuntimeSchema.safeParse(runtime).success).toBe(true);
    }
  });

  test("records ContainerUri, the CLI's build mode for it, and no local image", () => {
    const metadata = template.Metadata as Record<string, Record<string, string>>;
    for (const [key, build] of Object.entries(BUILDS)) {
      expect(metadata["agentcore:builds"]![key]).toBe(build);
    }
    expect(metadata["agentcore:localImages"]).not.toHaveProperty("runtime/image");
  });

  test("deploys the image URI as is, with no build resources of its own", () => {
    const runtime = Object.values(template.Resources).find(
      (resource) => resource.Properties?.AgentRuntimeName === "Fixture_image",
    );
    expect(runtime?.Properties.AgentRuntimeArtifact).toEqual({
      ContainerConfiguration: {
        ContainerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1",
      },
    });
    const ids = Object.keys(template.Resources).filter((id) => id.includes("RuntimeImage"));
    expect(ids.map((id) => template.Resources[id]!.Type)).not.toContain("AWS::CodeBuild::Project");
  });

  test("agentcore build builds only the ContainerLocal images", async () => {
    const images = await localImageBuilds(json, FIXTURE, "Fixture", BUILDS);
    expect(images.map((image) => image.resource).sort()).toEqual([
      "harness/assistant",
      "runtime/orders",
    ]);
  });

  test("the switch guard allows ContainerUri transitions and still rejects Container to ContainerLocal and ContainerUri to CodeZip", () => {
    expect(() =>
      assertSupportedBuildTransitions(
        template,
        { ...BUILDS, "runtime/image": "ContainerLocal" },
        "Fixture",
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedBuildTransitions(
        template,
        { ...BUILDS, "runtime/billing": "ContainerUri" },
        "Fixture",
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedBuildTransitions(
        template,
        { ...BUILDS, "runtime/billing": "ContainerLocal" },
        "Fixture",
        undefined,
      ),
    ).toThrow("cannot be switched into or out of ContainerLocal");
    expect(() =>
      assertSupportedBuildTransitions(
        template,
        { ...BUILDS, "runtime/image": "CodeZip" },
        "Fixture",
        undefined,
      ),
    ).toThrow("Cannot change runtime/image from ContainerUri to CodeZip");
  });
});
