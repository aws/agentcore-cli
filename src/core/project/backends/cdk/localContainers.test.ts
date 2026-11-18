import { describe, expect, test } from "bun:test";
import { HarnessSpecSchema } from "../../../../projectSchemas/harness";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import type { WorkloadBuildMode } from "../../../../handlers/project/types";
import { assertSupportedBuildTransitions, type DeployedTemplate } from "./localContainers";

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
        ).toThrow("between Container and ContainerLocal is not supported");
      }
    },
  );
  test.each([
    ["CodeZip", "ContainerLocal"],
    ["ContainerLocal", "CodeZip"],
    ["Managed", "ContainerLocal"],
  ] as const satisfies [string, WorkloadBuildMode][])(
    "allows a deployed %s to %s transition",
    (before, after) => {
      const key = "runtime/agent";
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
      ).toThrow("between Container and ContainerLocal is not supported");
    },
  );
  test("allows a pre-feature CodeZip runtime to become ContainerLocal", () => {
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
    ).not.toThrow();
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
    ).toThrow("between Container and ContainerLocal is not supported");
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
