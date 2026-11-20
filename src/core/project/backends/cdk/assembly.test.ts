import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import {
  assertPlatformVersions,
  assertPrivateVpcs,
  countDeployableResources,
  stackArtifactForTarget,
} from "./assembly";

const temporaryDirectories: string[] = [];
const json = new FsReadWriteJson({ logger: createSilentLogger() });

const TEMPLATE_FILE = "stack.template.json";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function assembly(artifacts: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-assembly-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ artifacts }));
  return directory;
}

/** A stack artifact for `target`, bound to EXPECTED unless `overrides` says otherwise. */
function stackArtifact(target: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "aws:cloudformation:stack",
    properties: {
      tags: { "agentcore:target-name": target },
      templateFile: TEMPLATE_FILE,
    },
    ...overrides,
  };
}

async function writeTemplate(directory: string, resources: Record<string, unknown>): Promise<void> {
  await writeFile(join(directory, TEMPLATE_FILE), JSON.stringify({ Resources: resources }));
}

describe("stackArtifactForTarget", () => {
  test("selects by the target tag instead of deriving a stack name", async () => {
    const directory = await assembly({ "nested/stack-id": stackArtifact("prod") });

    expect(await stackArtifactForTarget(json, directory, "prod")).toEqual({
      id: "nested/stack-id",
      // No stackName in the manifest, so CloudFormation knows the stack by its
      // artifact id — the same fallback CDK itself applies.
      stackName: "nested/stack-id",
      templateFile: TEMPLATE_FILE,
    });
  });

  test("prefers the manifest's stack name over the artifact id", async () => {
    const directory = await assembly({
      "nested/stack-id": stackArtifact("prod", {
        properties: {
          tags: { "agentcore:target-name": "prod" },
          templateFile: TEMPLATE_FILE,
          stackName: "AgentCore-example-prod",
        },
      }),
    });

    expect(await stackArtifactForTarget(json, directory, "prod")).toEqual({
      id: "nested/stack-id",
      stackName: "AgentCore-example-prod",
      templateFile: TEMPLATE_FILE,
    });
  });

  test("ignores non-stack artifacts", async () => {
    const directory = await assembly({
      Tree: {
        type: "cdk:tree",
        properties: { tags: { "agentcore:target-name": "prod" } },
      },
    });

    await expect(stackArtifactForTarget(json, directory, "prod")).rejects.toThrow(
      /defines 0 stack/,
    );
  });

  test("reports a missing manifest before attempting deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-assembly-"));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });

    await expect(stackArtifactForTarget(json, directory, "prod")).rejects.toThrow(
      /No synthesized cloud assembly was found/,
    );
  });
});

describe("assertPrivateVpcs", () => {
  const artifact = { id: "Stack", stackName: "Stack", templateFile: TEMPLATE_FILE };
  const vpc = (tag?: string) => ({
    Type: "AWS::EC2::VPC",
    Properties: { Tags: tag ? [{ Key: "agentcore:secure-vpc", Value: tag }] : [] },
  });

  test.each([
    [
      "a private VPC tagged for the runtime",
      { Vpc: vpc("AgentCore-App-default/agent") },
      ["agent"],
    ],
    ["no PRIVATE_VPC runtime", { Runtime: { Type: "AWS::BedrockAgentCore::Runtime" } }, []],
  ])("accepts %s", async (_name, resources, runtimeNames) => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, resources);

    await expect(
      assertPrivateVpcs(json, directory, artifact, runtimeNames),
    ).resolves.toBeUndefined();
  });

  test.each([
    ["no VPC, as a CDK library from before containment synthesizes", {}],
    ["a VPC tagged for another runtime", { Vpc: vpc("AgentCore-App-default/other") }],
    ["an untagged VPC", { Vpc: vpc() }],
  ])("refuses %s", async (_name, resources) => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, {
      Runtime: { Type: "AWS::BedrockAgentCore::Runtime" },
      ...resources,
    });

    await expect(assertPrivateVpcs(json, directory, artifact, ["agent"])).rejects.toThrow(
      'Runtime \'agent\' has "containment": "PRIVATE_VPC", but the synthesized stack builds no private VPC for it',
    );
  });
});

describe("assertPlatformVersions", () => {
  const artifact = { id: "Stack", stackName: "AgentCore-App-default", templateFile: TEMPLATE_FILE };
  /** A runtime resource, and the RuntimeId export the CDK library writes for runtime `name`. */
  const runtime = (name: string, logicalId: string, properties: Record<string, unknown>) => ({
    Resources: { [logicalId]: { Type: "AWS::BedrockAgentCore::Runtime", Properties: properties } },
    Outputs: {
      [`${logicalId}Id`]: {
        Value: { "Fn::GetAtt": [logicalId, "AgentRuntimeId"] },
        Export: { Name: `AgentCore-App-default-${name.replaceAll("_", "-")}-RuntimeId` },
      },
    },
  });
  async function check(template: Record<string, unknown>, runtimeNames: string[]) {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeFile(join(directory, TEMPLATE_FILE), JSON.stringify(template));
    return assertPlatformVersions(json, directory, artifact, runtimeNames, "V2");
  }

  test("accepts a runtime that runs on the version", async () => {
    await expect(
      check(runtime("my_agent", "RuntimeMyAgent", { PlatformVersion: "V2" }), ["my_agent"]),
    ).resolves.toBeUndefined();
  });

  test("accepts a stack with no runtime to check", async () => {
    await expect(check({ Resources: {} }, [])).resolves.toBeUndefined();
  });

  test.each([
    ["no PlatformVersion, as a CDK library from before platformVersion synthesizes", {}],
    ["another PlatformVersion", { PlatformVersion: "V1" }],
  ])("refuses %s", async (_name, properties) => {
    await expect(check(runtime("agent", "RuntimeAgent", properties), ["agent"])).rejects.toThrow(
      'Runtime \'agent\' has "platformVersion": "V2", but the synthesized stack does not set it.',
    );
  });

  test("refuses a runtime the stack exports no RuntimeId for", async () => {
    await expect(
      check(runtime("other", "RuntimeOther", { PlatformVersion: "V2" }), ["agent"]),
    ).rejects.toThrow('Runtime \'agent\' has "platformVersion": "V2"');
  });
});

describe("countDeployableResources", () => {
  const artifact = { id: "Stack", stackName: "Stack", templateFile: TEMPLATE_FILE };

  test("counts the resources the project asked for", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, {
      Runtime: { Type: "AWS::BedrockAgentCore::Runtime" },
      Role: { Type: "AWS::IAM::Role" },
    });

    expect(await countDeployableResources(json, directory, artifact)).toBe(2);
  });

  test("does not count the metadata resource CDK adds on its own", async () => {
    // The reason a check for an empty Resources block never fires: an empty
    // project still synthesizes this.
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, { CDKMetadata: { Type: "AWS::CDK::Metadata" } });

    expect(await countDeployableResources(json, directory, artifact)).toBe(0);
  });

  test("counts a real resource sitting alongside the metadata one", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, {
      CDKMetadata: { Type: "AWS::CDK::Metadata" },
      Runtime: { Type: "AWS::BedrockAgentCore::Runtime" },
    });

    expect(await countDeployableResources(json, directory, artifact)).toBe(1);
  });

  test("counts an untyped resource, rather than reading a broken template as empty", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, { Mystery: {} });

    expect(await countDeployableResources(json, directory, artifact)).toBe(1);
  });

  test("reports an empty Resources block as nothing to deploy", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });
    await writeTemplate(directory, {});

    expect(await countDeployableResources(json, directory, artifact)).toBe(0);
  });

  test("rejects a template the assembly names but does not contain", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });

    await expect(countDeployableResources(json, directory, artifact)).rejects.toThrow(
      /synthesized template for stack 'Stack' is missing/,
    );
  });

  test("rejects a stack artifact that names no template at all", async () => {
    const directory = await assembly({ Stack: stackArtifact("prod") });

    await expect(
      countDeployableResources(json, directory, { ...artifact, templateFile: undefined }),
    ).rejects.toThrow(/names no template file/);
  });
});
