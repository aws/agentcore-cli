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
  runtimeVersion: "PYTHON_3_12" as const,
};
const containerAgent = {
  name: "agent",
  build: "Container" as const,
  entrypoint: "main.py",
  codeLocation: "./agent",
};
const privateContainerUri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/team/agent:latest";
const publicContainerUri = `public.ecr.aws/example/agent@sha256:${"a".repeat(64)}`;
const prebuiltAgent = {
  ...containerAgent,
  containerUri: privateContainerUri,
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
  it("keeps V2 resource and hook fields it does not model, and rejects invalid ones", () => {
    const warmup = { action: { httpPost: { path: "/warmup", port: 8080 } } };
    expect(
      ProjectRuntimeSchema.safeParse({
        ...codeZipAgent,
        resourceConfigurations: [{ minimumMemoryInMiB: 4096 }],
        hooksConfiguration: { build: { warmup } },
      }).success,
    ).toBe(true);
    const unmodeled = {
      build: { warmup: { action: { httpPost: { path: "/w", timeoutSeconds: 30 } } } },
    };
    expect(
      ProjectRuntimeSchema.parse({ ...codeZipAgent, hooksConfiguration: unmodeled })
        .hooksConfiguration,
    ).toEqual(unmodeled);
    for (const fields of [
      { hooksConfiguration: { build: { warmup: { action: { httpPost: { path: "" } } } } } },
      { resourceConfigurations: [{ minimumMemoryInMiB: 0 }] },
    ]) {
      expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...fields }).success).toBe(false);
    }
  });
  it("accepts only the V1 and V2 platform versions", () => {
    for (const platformVersion of ["V1", "V2"]) {
      expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, platformVersion }).success).toBe(
        true,
      );
    }
    for (const platformVersion of ["v2", "V3", ""]) {
      expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, platformVersion }).success).toBe(
        false,
      );
    }
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
  it("requires runtimeVersion for CodeZip builds only", () => {
    const { runtimeVersion: _omitted, ...withoutVersion } = codeZipAgent;
    const result = ProjectRuntimeSchema.safeParse(withoutVersion);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["runtimeVersion"]);

    // Container builds take their version from the image.
    expect(ProjectRuntimeSchema.safeParse(containerAgent).success).toBe(true);
  });
  it("restricts container-only fields to container builds", () => {
    for (const field of [
      { containerUri: privateContainerUri },
      { dockerfile: "Dockerfile" },
      { buildContextPath: "." },
      { customDockerBuildArgs: { KEY: "value" } },
    ]) {
      expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...field }).success).toBe(false);
      expect(ProjectRuntimeSchema.safeParse({ ...containerAgent, ...field }).success).toBe(true);
    }
  });
  it.each([privateContainerUri, publicContainerUri])(
    "accepts a supported pre-built ECR image URI: %s",
    (containerUri) => {
      expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, containerUri }).success).toBe(true);
    },
  );
  it.each([
    "docker.io/example/agent:latest",
    "12345678901.dkr.ecr.us-east-1.amazonaws.com/agent:latest",
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/UPPERCASE:latest",
    `${privateContainerUri}${"x".repeat(1025)}`,
  ])("rejects an invalid pre-built image URI: %s", (containerUri) => {
    expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, containerUri }).success).toBe(false);
  });
  const ecr = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
  it.each([
    `${ecr}/ab:v1`,
    `${ecr}/${"a".repeat(256)}:v1`,
    `public.ecr.aws/myalias/${"a".repeat(205)}:v1`,
    `public.ecr.aws/myalias/ns/${"a".repeat(202)}:v1`,
    "public.ecr.aws/myalias/ab:v1",
    `${ecr}/agent:_v1.0-rc`,
    `${ecr}/agent:${"a".repeat(128)}`,
    `${ecr}/agent@sha256:${"0".repeat(64)}`,
    `${ecr}/agent:v1@sha512:${"f".repeat(128)}`,
  ])("accepts a URI within the service image grammar: %s", (containerUri) => {
    expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, containerUri }).success).toBe(true);
  });
  it.each([
    [`${ecr}/agent:v1 `, "containerUri must not contain whitespace"],
    [`${ecr}/agent:v1 v2\n`, "containerUri must not contain whitespace"],
    [` ${ecr}/agent:v1`, "containerUri must not contain whitespace"],
    [`${ecr}/agent:v1!`, "containerUri tag must start with a letter, digit or '_'"],
    [`${ecr}/agent:.v1`, "containerUri tag must start with a letter, digit or '_'"],
    [`${ecr}/agent:${"a".repeat(129)}`, "containerUri tag must start with a letter, digit or '_'"],
    [`${ecr}/agent@sha256:XYZ`, "containerUri digest must be sha256:<64 hex digits>"],
    [`${ecr}/agent@md5:abc`, "containerUri digest must be sha256:<64 hex digits>"],
    [`${ecr}/agent@sha256:${"A".repeat(64)}`, "containerUri digest must be sha256:<64 hex digits>"],
    [`${ecr}/a:v1`, "containerUri repository name must be 2-256 characters"],
    [`${ecr}/${"a".repeat(257)}:v1`, "containerUri repository name must be 2-256 characters"],
    [
      `public.ecr.aws/myalias/${"a".repeat(206)}:v1`,
      "containerUri repository name must be 2-205 characters",
    ],
    ["public.ecr.aws/myalias/a:v1", "containerUri repository name must be 2-205 characters"],
    [
      "public.ecr.aws/abcdefgh:v1",
      "containerUri for public.ecr.aws must name a registry alias and a repository",
    ],
    [
      "public.ecr.aws/abcdefgh",
      "containerUri for public.ecr.aws must name a registry alias and a repository",
    ],
    [
      `public.ecr.aws/myalias/agent@sha256:${"A".repeat(64)}`,
      "containerUri digest must be sha256:<64 hex digits>",
    ],
  ])("rejects a URI outside the service image grammar: %s", (containerUri, message) => {
    const result = ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, containerUri });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("; ")).toContain(message);
  });
  it.each([
    { dockerfile: "Dockerfile" },
    { buildContextPath: "." },
    { customDockerBuildArgs: { STAGE: "prod" } },
  ])("rejects local build configuration with containerUri: %j", (field) => {
    expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, ...field }).success).toBe(false);
  });
  it.each(["CodeZip", "ContainerLocal"])(
    "requires build Container with containerUri, not %s",
    (build) => {
      const result = ProjectRuntimeSchema.safeParse({
        ...prebuiltAgent,
        build,
        runtimeVersion: "PYTHON_3_12",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["containerUri"],
          message:
            "containerUri requires build 'Container' (it cannot be used with CodeZip or ContainerLocal)",
        }),
      );
    },
  );
  it("exempts a pre-built image from the CodeBuild VPC limits", () => {
    expect(
      ProjectRuntimeSchema.safeParse({
        ...prebuiltAgent,
        networkMode: "VPC",
        networkConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: Array.from({ length: 6 }, (_, i) => `sg-${String(i).padStart(17, "0")}`),
        },
      }).success,
    ).toBe(true);
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
      networkConfig: { ...networkConfig, securityGroups, vpcId: "vpc-0123456789abcdef0" },
    };
    const capped = ProjectRuntimeSchema.safeParse({ ...containerAgent, ...vpc });
    expect(capped.success).toBe(false);
    expect(capped.error?.issues[0]?.path).toEqual(["networkConfig", "securityGroups"]);
    expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...vpc }).success).toBe(true);
    expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, ...vpc }).success).toBe(true);
  });
  it("requires a VPC ID for container builds in VPC mode only", () => {
    const vpc = { networkMode: "VPC" as const, networkConfig };
    const missing = ProjectRuntimeSchema.safeParse({ ...containerAgent, ...vpc });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(["networkConfig", "vpcId"]);
    expect(
      ProjectRuntimeSchema.safeParse({
        ...containerAgent,
        networkMode: "VPC",
        networkConfig: { ...networkConfig, vpcId: "vpc-0123456789abcdef0" },
      }).success,
    ).toBe(true);

    // CodeZip never reaches CodeBuild, so it needs no VPC ID.
    expect(ProjectRuntimeSchema.safeParse({ ...codeZipAgent, ...vpc }).success).toBe(true);
    expect(ProjectRuntimeSchema.safeParse({ ...prebuiltAgent, ...vpc }).success).toBe(true);
    expect(ProjectRuntimeSchema.safeParse(containerAgent).success).toBe(true);
  });
});

describe("s3BucketMount validation", () => {
  const v2Agent = { ...codeZipAgent, platformVersion: "V2" as const };
  const withMount = (s3BucketMount: Record<string, unknown>, agent: object = v2Agent) =>
    ProjectRuntimeSchema.safeParse({
      ...agent,
      filesystemConfigurations: [
        {
          s3BucketMount: {
            bucket: "amzn-s3-demo-bucket",
            mountPath: "/mnt/bucket",
            ...s3BucketMount,
          },
        },
      ],
    });
  const messages = (result: ReturnType<typeof withMount>) =>
    result.error?.issues.map((issue) => issue.message) ?? [];

  it("accepts a whole-bucket mount in PUBLIC and VPC network mode on V2", () => {
    expect(withMount({}, { ...v2Agent, networkMode: "PUBLIC" }).success).toBe(true);
    expect(withMount({}, { ...v2Agent, networkMode: "VPC", networkConfig }).success).toBe(true);
  });
  it("rejects a misspelled field instead of dropping it", () => {
    const result = withMount({ s3BucketOwnr: "123456789012" });
    expect(result.success).toBe(false);
  });
  it("accepts every optional field", () => {
    expect(
      withMount({
        prefix: "data/{runtimeSessionId}/",
        s3BucketOwner: "123456789012",
        s3BucketRegion: "us-east-1",
      }).success,
    ).toBe(true);
  });
  it("leaves the platformVersion V2 rule to the service", () => {
    for (const agent of [codeZipAgent, { ...codeZipAgent, platformVersion: "V1" }]) {
      expect(withMount({}, agent).success).toBe(true);
    }
  });
  it("counts toward the five-mount limit with no cap of its own", () => {
    const mounts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        s3BucketMount: { bucket: "amzn-s3-demo-bucket", mountPath: `/mnt/bucket${index}` },
      }));
    expect(
      ProjectRuntimeSchema.safeParse({ ...v2Agent, filesystemConfigurations: mounts(5) }).success,
    ).toBe(true);
    expect(
      ProjectRuntimeSchema.safeParse({ ...v2Agent, filesystemConfigurations: mounts(6) }).success,
    ).toBe(false);
  });
  it("rejects a mount path another mount type already uses", () => {
    const result = ProjectRuntimeSchema.safeParse({
      ...v2Agent,
      filesystemConfigurations: [
        { sessionStorage: { mountPath: "/mnt/data" } },
        { s3BucketMount: { bucket: "amzn-s3-demo-bucket", mountPath: "/mnt/data/" } },
      ],
    });
    expect(messages(result)).toContain("Filesystem mount paths must be unique");
  });
  it("checks only the bucket and prefix length, leaving their rules to the CDK app", () => {
    for (const bucket of ["my.bucket-1", "my-bucket--usw2-az1--x-s3", "my-mrap.mrap"]) {
      expect(withMount({ bucket }).success).toBe(true);
    }
    expect(withMount({ bucket: "ab" }).success).toBe(false);
    expect(withMount({ bucket: "a".repeat(64) }).success).toBe(false);
    expect(withMount({ prefix: "data/{runtimeSessionId}/" }).success).toBe(true);
    expect(withMount({ prefix: "" }).success).toBe(false);
    expect(withMount({ prefix: "a".repeat(1025) }).success).toBe(false);
  });
  it("checks the bucket owner and Region formats", () => {
    expect(withMount({ s3BucketOwner: "12345678901" }).success).toBe(false);
    expect(withMount({ s3BucketRegion: "uswest2" }).success).toBe(false);
  });
});
