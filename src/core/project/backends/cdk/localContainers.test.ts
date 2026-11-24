import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../../../errors";
import { HarnessSpecSchema } from "../../../../projectSchemas/harness";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import type { Project, WorkloadBuildMode } from "../../../../handlers/project/types";
import {
  assertSupportedBuildTransitions,
  resolveWorkloads,
  type DeployedTemplate,
} from "./localContainers";

describe("resolveWorkloads", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function harnessProject(entryName: string, yaml: string): Project {
    const rootPath = mkdtempSync(join(tmpdir(), "agentcore-local-containers-"));
    roots.push(rootPath);
    mkdirSync(join(rootPath, "app", "helper"), { recursive: true });
    writeFileSync(join(rootPath, "app", "helper", "harness.yaml"), yaml);
    const spec = ProjectSpecSchema.parse({ name: "example", version: 2 });
    spec.harnesses.push({ name: entryName, path: join("app", "helper") });
    return { name: "example", rootPath, spec };
  }

  test("keys a harness by its agentcore.json entry name, not the name in harness.yaml", () => {
    const p = harnessProject(
      "helper",
      "name: renamed\nmodel: {bedrockModelConfig: {modelId: test-model}}\n" +
        "dockerfile: Dockerfile\nbuild: ContainerLocal\n",
    );
    const { builds, local } = resolveWorkloads(p);
    expect(builds).toEqual({ "harness/helper": "ContainerLocal" });
    expect([...local.keys()]).toEqual(["harness/helper"]);
  });
  test("names the file when harness.yaml is invalid", () => {
    const p = harnessProject("helper", "name: helper\nbuild: NotABuildMode\n");
    const error = (() => {
      try {
        resolveWorkloads(p);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(InputValidationError);
    const message = (error as Error).message;
    expect(message).toContain(
      `Invalid harness.yaml at '${join(p.rootPath, "app", "helper", "harness.yaml")}'`,
    );
    expect(message).toContain("build");
  });
});

describe("container configuration", () => {
  const networkConfig = {
    subnets: ["subnet-0123456789abcdef0"],
    securityGroups: Array.from({ length: 6 }, (_, index) => `sg-0123456789abcde${index}0`),
  };
  test("local runtime builds use workload networking limits rather than CodeBuild requirements", () => {
    expect(
      ProjectRuntimeSchema.safeParse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(true);
  });
  test("local harness builds accept workload networking without a CodeBuild VPC ID", () => {
    expect(
      HarnessSpecSchema.safeParse({
        name: "agent",
        model: { provider: "bedrock", modelId: "test-model" },
        build: "ContainerLocal",
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(true);
  });
  test("applies the CodeBuild reserved build-arg rule to Container builds only", () => {
    const customDockerBuildArgs = { AWS_REGION: "us-west-2", CODEBUILD_X: "1" };
    const runtime = (build: string) =>
      ProjectRuntimeSchema.safeParse({
        name: "agent",
        build,
        codeLocation: "app/agent",
        entrypoint: "main.py",
        dockerfile: "Dockerfile",
        customDockerBuildArgs,
      }).success;
    const harness = (build: string | undefined) =>
      HarnessSpecSchema.safeParse({
        name: "agent",
        model: { provider: "bedrock", modelId: "test-model" },
        ...(build && { build }),
        dockerfile: "Dockerfile",
        customDockerBuildArgs,
      }).success;
    expect(runtime("ContainerLocal")).toBe(true);
    expect(runtime("Container")).toBe(false);
    expect(harness("ContainerLocal")).toBe(true);
    expect(harness("Container")).toBe(false);
    expect(harness(undefined)).toBe(false);
  });
  test.each(["Container", "ContainerLocal"])(
    "rejects explicit %s build settings for a prebuilt harness image",
    (build) => {
      expect(
        HarnessSpecSchema.safeParse({
          name: "agent",
          model: { provider: "bedrock", modelId: "test-model" },
          build,
          containerUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/image:latest",
        }).success,
      ).toBe(false);
    },
  );
});

describe("assertSupportedBuildTransitions", () => {
  test.each([
    ["Container", "ContainerLocal"],
    ["ContainerLocal", "Container"],
    ["CodeZip", "ContainerLocal"],
    ["ContainerLocal", "CodeZip"],
    ["Managed", "ContainerLocal"],
    ["ContainerLocal", "Managed"],
  ] as const satisfies [string, WorkloadBuildMode][])(
    "rejects a deployed %s to %s transition",
    (before, after) => {
      for (const kind of ["runtime", "harness"]) {
        const key = `${kind}/agent`;
        expect(() =>
          assertSupportedBuildTransitions(
            { Metadata: { "agentcore:builds": { [key]: before } } },
            { [key]: after },
            "example",
            "default",
          ),
        ).toThrow("cannot be switched into or out of ContainerLocal");
      }
    },
  );
  test.each([
    ["CodeZip", "Container", 'delete the Dockerfile and set "build": "CodeZip" in agentcore.json'],
    ["Container", "CodeZip", 'set "build": "Container" and its "dockerfile" in agentcore.json'],
  ] as const)("rejects a deployed runtime %s to %s transition", (before, after, keep) => {
    expect(() =>
      assertSupportedBuildTransitions(
        { Metadata: { "agentcore:builds": { "runtime/agent": before } } },
        { "runtime/agent": after },
        "example",
        "default",
      ),
    ).toThrow(
      `Cannot change runtime/agent from ${before} to ${after}. The service does not allow ` +
        "changing a Runtime's artifact type, so the deploy would fail and roll back. Add a " +
        `Runtime with a new name, or keep the deployed build: ${keep}`,
    );
  });
  test("rejects a pre-feature CodeZip runtime becoming Container", () => {
    const previous: DeployedTemplate = {
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: {
            AgentRuntimeName: "example_default_agent",
            AgentRuntimeArtifact: { CodeConfiguration: { Code: {} } },
          },
        },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "Container" },
        "example",
        "default",
      ),
    ).toThrow("Cannot change runtime/agent from CodeZip to Container");
  });
  test.each([
    ["Managed", "Container"],
    ["Container", "Managed"],
  ] as const)("leaves a deployed harness %s to %s transition allowed", (before, after) => {
    expect(() =>
      assertSupportedBuildTransitions(
        { Metadata: { "agentcore:builds": { "harness/agent": before } } },
        { "harness/agent": after },
        "example",
        "default",
      ),
    ).not.toThrow();
  });
  test.each([
    ["ContainerUri", "ContainerLocal"],
    ["ContainerLocal", "ContainerUri"],
    ["Managed", "ContainerUri"],
  ] as const satisfies [string, WorkloadBuildMode][])(
    "allows a deployed %s to %s transition",
    (before, after) => {
      const key = "harness/agent";
      expect(() =>
        assertSupportedBuildTransitions(
          { Metadata: { "agentcore:builds": { [key]: before } } },
          { [key]: after },
          "example",
          "default",
        ),
      ).not.toThrow();
    },
  );
  test("allows unchanged local workloads and new workloads in an existing mixed project", () => {
    expect(() =>
      assertSupportedBuildTransitions(
        {
          Metadata: {
            "agentcore:builds": {
              "runtime/existing": "Container",
              "harness/local": "ContainerLocal",
            },
          },
        },
        {
          "runtime/existing": "Container",
          "harness/local": "ContainerLocal",
          "runtime/new": "ContainerLocal",
        },
        "example",
        "default",
      ),
    ).not.toThrow();
  });
  test.each(["runtime", "harness"] as const)(
    "detects pre-feature %s templates without local state",
    (kind) => {
      const previous: DeployedTemplate = {
        Resources: {
          Workload: {
            Type:
              kind === "runtime"
                ? "AWS::BedrockAgentCore::Runtime"
                : "AWS::BedrockAgentCore::Harness",
            Properties: {
              [kind === "runtime" ? "AgentRuntimeName" : "HarnessName"]: "example_prod_us_agent",
              [kind === "runtime" ? "AgentRuntimeArtifact" : "EnvironmentArtifact"]: {
                ContainerConfiguration: { ContainerUri: "image" },
              },
            },
          },
        },
      };
      expect(() =>
        assertSupportedBuildTransitions(
          previous,
          { [`${kind}/agent` as const]: "ContainerLocal" as const },
          "example",
          "prod-us",
        ),
      ).toThrow("cannot be switched into or out of ContainerLocal");
    },
  );
  test("rejects a pre-feature CodeZip runtime becoming ContainerLocal", () => {
    const previous: DeployedTemplate = {
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: {
            AgentRuntimeName: "example_default_agent",
            AgentRuntimeArtifact: { CodeConfiguration: { Code: {} } },
          },
        },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "ContainerLocal" },
        "example",
        "default",
      ),
    ).toThrow("Cannot change runtime/agent from CodeZip to ContainerLocal");
  });
  test("says how to recover: a new name, the deployed build mode, or deploying the removal first", () => {
    expect(() =>
      assertSupportedBuildTransitions(
        { Metadata: { "agentcore:builds": { "runtime/agent": "Container" } } },
        { "runtime/agent": "ContainerLocal" },
        "example",
        "default",
      ),
    ).toThrow(
      /only a new workload can use ContainerLocal\. Keep the deployed build mode \(Container\), or add a workload with a new name\..*deploy the removal first, then add it again\./,
    );
  });
  test("recognizes v0 target-less physical names", () => {
    const previous: DeployedTemplate = {
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: {
            AgentRuntimeName: "example_agent",
            AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: "image" } },
          },
        },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "ContainerLocal" },
        "example",
        undefined,
      ),
    ).toThrow("Cannot change runtime/agent from Container to ContainerLocal");
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "Container" },
        "example",
        undefined,
      ),
    ).not.toThrow();
  });
  test("treats workloads absent from a legacy template as new", () => {
    const previous: DeployedTemplate = {
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: { AgentRuntimeName: "example_default_other" },
        },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "ContainerLocal", "harness/agent": "ContainerLocal" },
        "example",
        "default",
      ),
    ).not.toThrow();
  });
  test("trusts recorded metadata over legacy name matching", () => {
    const previous: DeployedTemplate = {
      Metadata: { "agentcore:builds": { "runtime/agent": "ContainerLocal" } },
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: { AgentRuntimeName: "example_default_agent" },
        },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "ContainerLocal" },
        "example",
        "default",
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "runtime/agent": "Container" },
        "example",
        "default",
      ),
    ).toThrow("Cannot change runtime/agent from ContainerLocal to Container");
  });
  test("fails closed on malformed deployed build metadata", () => {
    expect(() =>
      assertSupportedBuildTransitions(
        { Metadata: { "agentcore:builds": [] } },
        {},
        "example",
        "default",
      ),
    ).toThrow("invalid build metadata");
  });
  test("rejects adopting an existing legacy role-only Harness into local mode", () => {
    const previous: DeployedTemplate = {
      Outputs: {
        HarnessRole: { Export: { Name: "AgentCore-example-default-Harness-assistant-RoleArn" } },
      },
    };
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "harness/assistant": "ContainerLocal" },
        "example",
        "default",
      ),
    ).toThrow("cannot be switched into or out of ContainerLocal");
    expect(() =>
      assertSupportedBuildTransitions(
        previous,
        { "harness/assistant": "Container" },
        "example",
        "default",
      ),
    ).not.toThrow();
  });
});
