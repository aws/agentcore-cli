import { describe, expect, test } from "bun:test";
import { buildBridgeTemplate, verifyBridge } from "./bridge";
import { resourceDigests } from "./digest";
import { mapLogicalIds, renamesOf } from "./mapping";
import { templateFixture } from "./migrate-test-support";
import type { CfnTemplate } from "./templates";

const clone = <T>(value: T): T => structuredClone(value);

describe("buildBridgeTemplate", () => {
  test("rebuilds the bridge template CloudFormation accepted in the live refactor", () => {
    const deployed = templateFixture("codezip.v0");
    const renames = renamesOf(mapLogicalIds(deployed, templateFixture("codezip.v1-rc3")));
    const bridge = buildBridgeTemplate(deployed, renames);
    expect(bridge).toEqual(templateFixture("codezip.bridge"));
    expect(verifyBridge(deployed, bridge, renames)).toEqual([]);
  });

  test("keeps DefaultPolicy names and custom resources where they are", () => {
    const deployed = templateFixture("container.v0");
    const renames = renamesOf(mapLogicalIds(deployed, templateFixture("container.v1-v0names")));
    const bridge = buildBridgeTemplate(deployed, renames);
    const policy =
      bridge.Resources!["ApplicationRuntimeMyagentRuntimeExecutionRoleDefaultPolicyA86B8133"]!;
    expect(policy.Properties?.PolicyName).toBe(
      "ApplicationAgentMyagentRuntimeExecutionRoleDefaultPolicyF8497769",
    );
    // The build trigger can't move, but now points at the moved handler.
    const trigger =
      bridge.Resources![
        "ApplicationAgentMyagentContainerImageBuilderContainerBuildTrigger59360A99"
      ]!;
    expect(trigger.Type).toBe("AWS::CloudFormation::CustomResource");
    expect(JSON.stringify(trigger)).toContain(
      "ApplicationRuntimeMyagentContainerImageBuilderContainerBuildHandler10251CED",
    );
    expect(verifyBridge(deployed, bridge, renames)).toEqual([]);
  });

  test("renames in resources, DependsOn (both forms), outputs, conditions, and Fn::Sub", () => {
    const deployed: CfnTemplate = {
      Conditions: { HasRole: { "Fn::Equals": [{ Ref: "Old" }, ""] } },
      Resources: {
        Old: { Type: "AWS::IAM::Role", Properties: {} },
        One: {
          Type: "AWS::IAM::Policy",
          DependsOn: "Old",
          Properties: { Roles: [{ Ref: "Old" }] },
        },
        Two: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["Old", "One"],
          Properties: { Role: { "Fn::Sub": "arn:${Old.Arn}" } },
        },
      },
      Outputs: { RoleArn: { Value: { "Fn::GetAtt": "Old.Arn" } } },
    };
    const renames = new Map([["Old", "New"]]);
    const bridge = buildBridgeTemplate(deployed, renames);
    expect(bridge).toEqual({
      Conditions: { HasRole: { "Fn::Equals": [{ Ref: "New" }, ""] } },
      Resources: {
        New: { Type: "AWS::IAM::Role", Properties: {} },
        One: {
          Type: "AWS::IAM::Policy",
          DependsOn: "New",
          Properties: { Roles: [{ Ref: "New" }] },
        },
        Two: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["New", "One"],
          Properties: { Role: { "Fn::Sub": "arn:${New.Arn}" } },
        },
      },
      Outputs: { RoleArn: { Value: { "Fn::GetAtt": "New.Arn" } } },
    });
    expect(verifyBridge(deployed, bridge, renames)).toEqual([]);
    // The input is never modified.
    expect(deployed.Resources!.Old).toBeDefined();
  });

  test("refuses a rename onto an ID already in use, or of a resource that isn't there", () => {
    const deployed: CfnTemplate = {
      Resources: { A: { Type: "T" }, B: { Type: "T" }, C: { Type: "T" } },
    };
    expect(() => buildBridgeTemplate(deployed, new Map([["A", "B"]]))).toThrow(
      "Can't rename 'A' to 'B': the deployed T 'B' keeps that logical ID.",
    );
    expect(() =>
      buildBridgeTemplate(
        deployed,
        new Map([
          ["A", "X"],
          ["C", "X"],
        ]),
      ),
    ).toThrow("Can't rename 'C' to 'X': another resource is renamed to it too.");
    expect(() => buildBridgeTemplate(deployed, new Map([["Z", "Y"]]))).toThrow(
      "the deployed template has no such resource",
    );
  });

  test("applies chained and swapped renames at once, so every reference follows its resource", () => {
    const deployed: CfnTemplate = {
      Resources: {
        A: { Type: "T", Properties: { Name: "a", Uses: { Ref: "B" } } },
        B: { Type: "T", Properties: { Name: "b", Uses: { "Fn::GetAtt": ["A", "Arn"] } } },
        C: { Type: "T", Properties: { Name: "c" }, DependsOn: ["A", "B"] },
      },
      Outputs: { O: { Value: { "Fn::Sub": "${A}/${B.Arn}" } } },
    };
    // Swap: A ↔ B.
    const swapped = buildBridgeTemplate(
      deployed,
      new Map([
        ["A", "B"],
        ["B", "A"],
      ]),
    );
    expect(swapped.Resources).toEqual({
      B: { Type: "T", Properties: { Name: "a", Uses: { Ref: "A" } } },
      A: { Type: "T", Properties: { Name: "b", Uses: { "Fn::GetAtt": ["B", "Arn"] } } },
      C: { Type: "T", Properties: { Name: "c" }, DependsOn: ["B", "A"] },
    });
    expect(swapped.Outputs).toEqual({ O: { Value: { "Fn::Sub": "${B}/${A.Arn}" } } });
    expect(
      verifyBridge(
        deployed,
        swapped,
        new Map([
          ["A", "B"],
          ["B", "A"],
        ]),
      ),
    ).toEqual([]);

    // Chain: A → B, B → C (C itself moves too, so nothing keeps a taken ID).
    const chain = new Map([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ]);
    const chained = buildBridgeTemplate(deployed, chain);
    expect(Object.keys(chained.Resources ?? {}).sort()).toEqual(["B", "C", "D"]);
    expect(chained.Resources?.B?.Properties).toEqual({ Name: "a", Uses: { Ref: "C" } });
    expect(chained.Resources?.D?.DependsOn).toEqual(["B", "C"]);
    expect(verifyBridge(deployed, chained, chain)).toEqual([]);
  });
});

describe("verifyBridge", () => {
  const deployed = templateFixture("pinned.v0");
  const renames = renamesOf(mapLogicalIds(deployed, templateFixture("pinned.v1")));

  test("flags a property change, a missing or extra resource, a type change, and changed outputs", () => {
    const changed = clone(buildBridgeTemplate(deployed, renames));
    const runtimeId = renames.get("ApplicationAgentMigagentRuntimeB6E7D059")!;
    changed.Resources![runtimeId]!.Properties!.Description = "changed";
    // The config bundle's components reference the runtime, so they differ too.
    expect(verifyBridge(deployed, changed, renames)).toEqual([
      `${runtimeId} (AWS::BedrockAgentCore::Runtime) differs from deployed ApplicationAgentMigagentRuntimeB6E7D059 beyond its logical ID.`,
      "ApplicationConfigBundleMigcbComponentsE5AB18B9 (Custom::AWSCDKCfnJson) differs from deployed ApplicationConfigBundleMigcbComponentsE5AB18B9 beyond its logical ID.",
      "ApplicationConfigBundleMigcbFF975EE3 (AWS::BedrockAgentCore::ConfigurationBundle) differs from deployed ApplicationConfigBundleMigcbFF975EE3 beyond its logical ID.",
    ]);

    const missing = clone(buildBridgeTemplate(deployed, renames));
    delete missing.Resources![runtimeId];
    missing.Resources!.Extra = { Type: "AWS::SNS::Topic" };
    missing.Resources!.Extra2 = { Type: "AWS::SNS::Topic" };
    const problems = verifyBridge(deployed, missing, renames);
    expect(problems[0]).toBe(
      `ApplicationAgentMigagentRuntimeB6E7D059 (AWS::BedrockAgentCore::Runtime) is missing from the bridge template as ${runtimeId}.`,
    );
    expect(problems.at(-1)).toBe("The bridge template has 1 more resources than the deployed one.");

    const retyped = clone(buildBridgeTemplate(deployed, renames));
    retyped.Resources![runtimeId]!.Type = "AWS::SNS::Topic";
    expect(verifyBridge(deployed, retyped, renames)[0]).toContain("changes type");

    const outputs = clone(buildBridgeTemplate(deployed, renames));
    outputs.Outputs = { ...outputs.Outputs, Added: { Value: "x" } };
    expect(verifyBridge(deployed, outputs, renames)).toEqual([
      "The bridge template's Outputs section differs from the deployed one beyond logical IDs.",
    ]);

    const conditions = clone(buildBridgeTemplate(deployed, renames));
    conditions.Conditions = { Never: { "Fn::Equals": ["a", "b"] } };
    delete conditions.Description;
    expect(verifyBridge(deployed, conditions, renames)).toEqual([
      "The bridge template's Conditions section differs from the deployed one beyond logical IDs.",
      "The bridge template's Description section differs from the deployed one beyond logical IDs.",
    ]);
  });
});

describe("resourceDigests", () => {
  test("is the same for a template with only logical IDs renamed", () => {
    const deployed = templateFixture("container.v0");
    const renames = renamesOf(mapLogicalIds(deployed, templateFixture("container.v1-v0names")));
    const before = resourceDigests(deployed);
    const after = resourceDigests(buildBridgeTemplate(deployed, renames));
    for (const [id, digest] of before) expect(after.get(renames.get(id) ?? id)).toBe(digest);
    expect(before.has("CDKMetadata")).toBe(false);
  });

  test("changes for the resource that changed and everything that references it", () => {
    const template: CfnTemplate = {
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: { Path: "/" } },
        Policy: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role" }] } },
        Other: { Type: "AWS::SNS::Topic", Properties: {} },
      },
    };
    const changed = clone(template);
    changed.Resources!.Role!.Properties!.Path = "/x/";
    const [a, b] = [resourceDigests(template), resourceDigests(changed)];
    expect(b.get("Role")).not.toBe(a.get("Role"));
    expect(b.get("Policy")).not.toBe(a.get("Policy"));
    expect(b.get("Other")).toBe(a.get("Other"));
  });

  test("tells apart the attribute a reference reads, but not which resource it names", () => {
    const reading = (attribute: string, parameter = "P"): CfnTemplate => ({
      Parameters: { P: { Type: "String" }, Q: { Type: "String" } },
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: {} },
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: { Role: { "Fn::GetAtt": ["Role", attribute] }, Name: { Ref: parameter } },
        },
      },
    });
    expect(resourceDigests(reading("Arn")).get("Fn")).not.toBe(
      resourceDigests(reading("RoleId")).get("Fn"),
    );
    expect(resourceDigests(reading("Arn", "P")).get("Fn")).not.toBe(
      resourceDigests(reading("Arn", "Q")).get("Fn"),
    );
  });

  test("ignores the CDK construct path and survives a reference cycle", () => {
    const withPath = (path: string): CfnTemplate => ({
      Resources: {
        A: {
          Type: "T",
          Metadata: { "aws:cdk:path": path, keep: 1 },
          Properties: { B: { Ref: "B" } },
        },
        B: { Type: "T", Properties: { A: { Ref: "A" } } },
      },
    });
    expect(resourceDigests(withPath("x/A"))).toEqual(resourceDigests(withPath("y/A")));
  });
});
