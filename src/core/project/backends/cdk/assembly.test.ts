import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { countDeployableResources, stackArtifactForTarget } from "./assembly";

const temporaryDirectories: string[] = [];
const json = new FsReadWriteJson({ logger: createSilentLogger() });

const EXPECTED = { account: "111122223333", region: "us-east-1" } as const;
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
    environment: `aws://${EXPECTED.account}/${EXPECTED.region}`,
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

    expect(await stackArtifactForTarget(json, directory, "prod", EXPECTED)).toEqual({
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

    expect(await stackArtifactForTarget(json, directory, "prod", EXPECTED)).toEqual({
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

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /defines 0 stack/,
    );
  });

  test("reports a missing manifest before attempting deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-assembly-"));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /No synthesized cloud assembly was found/,
    );
  });

  test("rejects a stack tagged for the target but built for another account", async () => {
    const directory = await assembly({
      Stack: stackArtifact("prod", { environment: `aws://999988887777/${EXPECTED.region}` }),
    });

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /built for account 999988887777 \(target expects 111122223333\)/,
    );
  });

  test("rejects a stack tagged for the target but built for another region", async () => {
    const directory = await assembly({
      Stack: stackArtifact("prod", { environment: `aws://${EXPECTED.account}/eu-west-1` }),
    });

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /built for region eu-west-1 \(target expects us-east-1\)/,
    );
  });

  test("names both halves when neither account nor region matches", async () => {
    const directory = await assembly({
      Stack: stackArtifact("prod", { environment: "aws://999988887777/eu-west-1" }),
    });

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /account 999988887777 \(target expects 111122223333\) and region eu-west-1/,
    );
  });

  test.each([
    ["no environment at all", undefined],
    ["CDK's unknown-* placeholders", "aws://unknown-account/unknown-region"],
  ])("accepts an environment-agnostic stack with %s", async (_label, environment) => {
    const directory = await assembly({
      // An absent key and an explicit undefined both mean "agnostic" once
      // serialized, which is what the manifest on disk actually looks like.
      Stack: stackArtifact("prod", { environment }),
    });

    expect((await stackArtifactForTarget(json, directory, "prod", EXPECTED)).id).toBe("Stack");
  });

  test("rejects an environment it cannot parse rather than assuming a match", async () => {
    const directory = await assembly({
      Stack: stackArtifact("prod", { environment: "us-east-1" }),
    });

    await expect(stackArtifactForTarget(json, directory, "prod", EXPECTED)).rejects.toThrow(
      /unrecognized environment 'us-east-1'/,
    );
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
