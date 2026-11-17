import { describe, expect, test } from "bun:test";
import { ContainerUriSchema, parseContainerUri } from "./container";

describe("ContainerUriSchema", () => {
  test.each([
    "111122223333.dkr.ecr.us-west-2.amazonaws.com/agent",
    "111122223333.dkr.ecr.us-west-2.amazonaws.com/team/agent:v1",
    "111122223333.dkr.ecr.cn-north-1.amazonaws.com.cn/agent:v1",
    "public.ecr.aws/example/agent:latest",
    "111122223333.dkr.ecr.us-west-2.amazonaws.com/agent@sha256:0123456789abcdef",
  ])("accepts %s", (uri) => {
    expect(ContainerUriSchema.safeParse(uri).success).toBe(true);
  });

  test.each([
    "",
    "agent:latest",
    "docker.io/library/python:3.12",
    "ghcr.io/example/agent:v1",
    "12345.dkr.ecr.us-west-2.amazonaws.com/agent",
    "111122223333.dkr.ecr.us-west-2.amazonaws.com/Agent",
    `111122223333.dkr.ecr.us-west-2.amazonaws.com/${"a".repeat(1100)}`,
  ])("rejects %p", (uri) => {
    expect(ContainerUriSchema.safeParse(uri).success).toBe(false);
  });
});

describe("parseContainerUri", () => {
  test("splits a private ECR URI into account, region, and repository", () => {
    expect(
      parseContainerUri("111122223333.dkr.ecr.eu-west-1.amazonaws.com/team/agent:v1@sha256:ab"),
    ).toEqual({
      registry: "private",
      account: "111122223333",
      region: "eu-west-1",
      repository: "team/agent",
    });
  });

  test("recognizes public.ecr.aws and rejects other registries", () => {
    expect(parseContainerUri("public.ecr.aws/example/agent")).toEqual({
      registry: "public",
      repository: "example/agent",
    });
    expect(parseContainerUri("docker.io/library/python")).toBeUndefined();
  });
});
