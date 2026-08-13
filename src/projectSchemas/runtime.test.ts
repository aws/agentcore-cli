import { describe, expect, it } from "bun:test";
import {
  ProjectRuntimeSchema,
  LifecycleConfigurationSchema,
  checkAllowlistHeader,
  isReservedBuildArgKey,
  isValidDockerfilePath,
} from "./runtime";
const codeZipAgent = {
  name: "agent",
  build: "CodeZip" as const,
  entrypoint: "main.py",
  codeLocation: "./agent",
};
const containerAgent = {
  name: "agent",
  build: "Container" as const,
  entrypoint: "main.py",
  codeLocation: "./agent",
};
const networkConfig = {
  subnets: ["subnet-0123456789abcdef0"],
  securityGroups: ["sg-0123456789abcdef0"],
};
describe("runtime custom validation", () => {
  it("validates Dockerfile paths through the shared guard", () => {
    expect(isValidDockerfilePath(".docker/Dockerfile")).toBe(true);
    for (const path of ["../Dockerfile", "/Dockerfile", "docker/", "a//Dockerfile", "a;rm"]) {
      expect(isValidDockerfilePath(path)).toBe(false);
    }
  });
  it("identifies build-environment-reserved argument names", () => {
    for (const key of ["IMAGE_URI", "PATH", "AWS_REGION", "CODEBUILD_ID"]) {
      expect(isReservedBuildArgKey(key)).toBe(true);
    }
    expect(isReservedBuildArgKey("USER")).toBe(false);
  });
  it("validates runtime header allowlist names and reserved prefixes", () => {
    expect(checkAllowlistHeader("X-Custom")).toBeNull();
    expect(checkAllowlistHeader("bad header")).not.toBeNull();
    expect(checkAllowlistHeader("x-amz-security-token")).not.toBeNull();
    expect(checkAllowlistHeader("x-amzn-trace-id")).not.toBeNull();
    expect(checkAllowlistHeader("X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant")).toBeNull();
  });
  it("requires lifecycle idle timeout not to exceed maximum lifetime", () => {
    expect(
      LifecycleConfigurationSchema.safeParse({
        idleRuntimeSessionTimeout: 1000,
        maxLifetime: 500,
      }).success,
    ).toBe(false);
  });
  it("couples VPC mode and network configuration", () => {
    expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, networkMode: "VPC" }).success).toBe(
      false,
    );
    expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, networkConfig }).success).toBe(false);
  });
  it("couples CUSTOM_JWT and authorizer configuration", () => {
    expect(
      ProjectRuntimeSchema.safeParse({ ...codeZipAgent, authorizerType: "CUSTOM_JWT" }).success,
    ).toBe(false);
    expect(
      ProjectRuntimeSchema.safeParse({
        ...codeZipAgent,
        authorizerType: "AWS_IAM",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://example.com/.well-known/openid-configuration",
          },
        },
      }).success,
    ).toBe(false);
  });
  it("restricts container-only fields to container builds", () => {
    for (const field of [
      { dockerfile: "Dockerfile" },
      { buildContextPath: "." },
      { customDockerBuildArgs: { KEY: "value" } },
    ]) {
      expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...field }).success).toBe(false);
      expect(ProjectRuntimeSchema.safeParse({ ...containerAgent, ...field }).success).toBe(true);
    }
  });
  it("rejects reserved build args and control characters", () => {
    expect(
      ProjectRuntimeSchema.safeParse({
        ...containerAgent,
        customDockerBuildArgs: { IMAGE_URI: "value" },
      }).success,
    ).toBe(false);
    expect(
      ProjectRuntimeSchema.safeParse({
        ...containerAgent,
        customDockerBuildArgs: { SAFE: "line1\nline2" },
      }).success,
    ).toBe(false);
  });
  it("enforces filesystem counts, VPC dependency, and unique mount paths", () => {
    const efsAccessPoint = {
      efsAccessPoint: {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/data",
      },
    };
    expect(
      ProjectRuntimeSchema.safeParse({
        ...codeZipAgent,
        filesystemConfigurations: [efsAccessPoint],
      }).success,
    ).toBe(false);
    expect(
      ProjectRuntimeSchema.safeParse({
        ...codeZipAgent,
        networkMode: "VPC",
        networkConfig,
        filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/data/" } }, efsAccessPoint],
      }).success,
    ).toBe(false);
    expect(
      ProjectRuntimeSchema.safeParse({
        ...codeZipAgent,
        filesystemConfigurations: Array.from({ length: 6 }, (_, index) => ({
          sessionStorage: { mountPath: `/mnt/data${index}` },
        })),
      }).success,
    ).toBe(false);
  });
  it("applies the CodeBuild security-group cap only to container builds", () => {
    const securityGroups = Array.from(
      { length: 6 },
      (_, index) => `sg-${String(index + 1).padStart(17, "0")}`,
    );
    const vpc = {
      networkMode: "VPC" as const,
      networkConfig: { ...networkConfig, securityGroups },
    };
    expect(ProjectRuntimeSchema.safeParse({ ...containerAgent, ...vpc }).success).toBe(false);
    expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...vpc }).success).toBe(true);
  });
});
