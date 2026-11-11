import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMovable, mapLogicalIds, renamesOf, type LogicalIdMapping } from "./mapping";
import { templateFixture } from "./migrate-test-support";
import type { CfnTemplate } from "./templates";

/** The mapping a live refactor of the same stacks used (`/tmp/compat-e2e/B1`, `/tmp/mig-synth`). */
function liveMapping(name: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "templates", `${name}.json`), "utf8"),
  ) as Record<string, string>;
}

const pairs = (mapping: LogicalIdMapping) =>
  Object.fromEntries(mapping.matches.map((match) => [match.from, match.to]));

describe("mapLogicalIds on saved templates", () => {
  test("CodeZip project: matches the mapping the live refactor used, roles and policies included", () => {
    const mapping = mapLogicalIds(templateFixture("codezip.v0"), templateFixture("codezip.v1-rc3"));
    // The hand-written live mapping had to add the runtime role, its DefaultPolicy,
    // and the evaluator Lambda's invoke permission by hand; all three come from
    // the reference graph here.
    expect(pairs(mapping)).toEqual(liveMapping("codezip.mapping"));
    expect(
      mapping.matches.find((m) => m.from.includes("Agent1RuntimeExecutionRoleDefault")),
    ).toEqual({
      from: "ApplicationAgentAgent1RuntimeExecutionRoleDefaultPolicy550C71C2",
      to: "ApplicationRuntimeAgent1RuntimeExecutionRoleDefaultPolicyC2FC8CDC",
      type: "AWS::IAM::Policy",
      reason: "reference",
    });
    expect(mapping.onlyInOld).toEqual([
      {
        logicalId: "ApplicationEvaluatorRefcodeFunctionAllowBedrockAgentCoreGetFunction83BAE833",
        type: "AWS::Lambda::Permission",
      },
      { logicalId: "McpGatewayRefgwRoleDefaultPolicy0A9745F9", type: "AWS::IAM::Policy" },
    ]);
    expect(mapping.onlyInNew).toEqual([]);
  });

  test("Container project: matches the live mapping, ECR repository and build chain included", () => {
    const mapping = mapLogicalIds(
      templateFixture("container.v0"),
      templateFixture("container.v1-v0names"),
    );
    expect(pairs(mapping)).toEqual(liveMapping("container.mapping"));
    expect(mapping.onlyInOld).toEqual([
      { logicalId: "McpGatewayMygwRoleDefaultPolicy7AEB4302", type: "AWS::IAM::Policy" },
    ]);
  });

  test("pairs resources whose names differ through their references", () => {
    // v1's default names differ from v0's for every AgentCore resource; the
    // gateway target keeps its name, and the gateway pairs through it.
    const mapping = mapLogicalIds(
      templateFixture("container.v0"),
      templateFixture("container.v1-v1names"),
    );
    expect(pairs(mapping)["McpGatewayMygw5B7E67C0"]).toBe("ApplicationGatewayMygw7D2DB91C");
    expect(mapping.matches.find((m) => m.from === "McpGatewayMygw5B7E67C0")?.reason).toBe(
      "reference",
    );
  });

  test("the live CompatMig stack with pinned names", () => {
    const mapping = mapLogicalIds(templateFixture("pinned.v0"), templateFixture("pinned.v1"));
    expect(renamesOf(mapping).size).toBe(10);
    expect(mapping.onlyInOld.map((entry) => entry.type)).toEqual(["AWS::IAM::Policy"]);
    expect(mapping.onlyInNew).toEqual([]);
  });
});

const role = (extra: Record<string, unknown> = {}) => ({
  Type: "AWS::IAM::Role",
  Properties: { AssumeRolePolicyDocument: {}, ...extra },
});

describe("mapLogicalIds rules", () => {
  test("named child resources with the same name pair up under their own parents", () => {
    const template = (prefix: string): CfnTemplate => ({
      Resources: Object.fromEntries(
        ["a", "b"].flatMap((gateway) => [
          [
            `${prefix}Gw${gateway}`,
            { Type: "AWS::BedrockAgentCore::Gateway", Properties: { Name: gateway } },
          ],
          [
            `${prefix}Gw${gateway}Target`,
            {
              Type: "AWS::BedrockAgentCore::GatewayTarget",
              Properties: { Name: "remote", GatewayIdentifier: { Ref: `${prefix}Gw${gateway}` } },
            },
          ],
        ]),
      ),
    });
    expect(pairs(mapLogicalIds(template("Old"), template("New")))).toEqual({
      OldGwa: "NewGwa",
      OldGwb: "NewGwb",
      OldGwaTarget: "NewGwaTarget",
      OldGwbTarget: "NewGwbTarget",
    });
  });

  test("breaks a tie by the resources' own properties, and leaves a real tie unmatched", () => {
    const permission = (action: string) => ({
      Type: "AWS::Lambda::Permission",
      Properties: { Action: action, FunctionName: { "Fn::GetAtt": ["Fn", "Arn"] } },
    });
    const fn = { Type: "AWS::Lambda::Function", Properties: { FunctionName: "f" } };
    const resolved = mapLogicalIds(
      {
        Resources: {
          Fn: fn,
          OldInvoke: permission("lambda:InvokeFunction"),
          OldGet: permission("lambda:GetFunction"),
        },
      },
      { Resources: { Fn: fn, NewInvoke: permission("lambda:InvokeFunction") } },
    );
    expect(pairs(resolved)).toEqual({ Fn: "Fn", OldInvoke: "NewInvoke" });
    expect(resolved.onlyInOld).toEqual([{ logicalId: "OldGet", type: "AWS::Lambda::Permission" }]);

    const tied = mapLogicalIds(
      { Resources: { Fn: fn, A: permission("x"), B: permission("x") } },
      { Resources: { Fn: fn, C: permission("x"), D: permission("x") } },
    );
    expect(pairs(tied)).toEqual({ Fn: "Fn" });
  });

  test("skips a name built from another resource's attribute, and pairs it by reference instead", () => {
    const named = (id: string): CfnTemplate => ({
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "b" } },
        [id]: {
          Type: "AWS::IAM::Role",
          Properties: { RoleName: { "Fn::Join": ["-", [{ Ref: "Bucket" }, "role"]] } },
        },
      },
    });
    const mapping = mapLogicalIds(named("OldRole"), named("NewRole"));
    expect(mapping.matches.find((m) => m.from === "OldRole")).toEqual({
      from: "OldRole",
      to: "NewRole",
      type: "AWS::IAM::Role",
      reason: "reference",
    });
  });

  test("doesn't pair on DependsOn alone, or when a shared property points at different resources", () => {
    const queue = (extra: Record<string, unknown>) => ({ Type: "AWS::SQS::Queue", ...extra });
    const runtime = {
      Type: "AWS::BedrockAgentCore::Runtime",
      Properties: { AgentRuntimeName: "a" },
    };
    const dependsOnly = mapLogicalIds(
      {
        Resources: { Rt: runtime, Q: queue({ DependsOn: "Rt", Properties: { DelaySeconds: 1 } }) },
      },
      {
        Resources: {
          Rt2: runtime,
          Other: queue({ DependsOn: "Rt2", Properties: { DelaySeconds: 9 } }),
        },
      },
    );
    expect(pairs(dependsOnly)).toEqual({ Rt: "Rt2" });

    const role = (name: string) => ({ Type: "AWS::IAM::Role", Properties: { RoleName: name } });
    const policy = (...roles: string[]) => ({
      Type: "AWS::IAM::Policy",
      Properties: { Roles: roles.map((id) => ({ Ref: id })) },
    });
    const conflicting = mapLogicalIds(
      { Resources: { A: role("a"), B: role("b"), Old: policy("A", "B") } },
      { Resources: { A2: role("a"), B2: role("b"), C2: role("c"), New: policy("A2", "C2") } },
    );
    // Old and New share role A but disagree on the other role in the same property.
    expect(pairs(conflicting)).toEqual({ A: "A2", B: "B2" });
    expect(conflicting.onlyInOld).toEqual([{ logicalId: "Old", type: "AWS::IAM::Policy" }]);
  });

  test("never pairs resources of different types, and leaves CDK metadata out of the lists", () => {
    const mapping = mapLogicalIds(
      { Resources: { Same: role(), CDKMetadata: { Type: "AWS::CDK::Metadata" } } },
      { Resources: { Same: { Type: "AWS::IAM::Policy", Properties: {} } } },
    );
    expect(mapping.matches).toEqual([]);
    expect(mapping.onlyInOld).toEqual([{ logicalId: "Same", type: "AWS::IAM::Role" }]);
    expect(mapping.onlyInNew).toEqual([{ logicalId: "Same", type: "AWS::IAM::Policy" }]);
  });
});

describe("renamesOf", () => {
  test("keeps only changed IDs of movable resources", () => {
    const renames = renamesOf({
      matches: [
        { from: "A", to: "B", type: "AWS::IAM::Role", reason: "reference" },
        { from: "C", to: "C", type: "AWS::IAM::Role", reason: "logical-id" },
        { from: "D", to: "E", type: "AWS::CloudFormation::CustomResource", reason: "reference" },
        { from: "F", to: "G", type: "Custom::AWSCDKCfnJson", reason: "reference" },
      ],
      onlyInOld: [],
      onlyInNew: [],
    });
    expect([...renames]).toEqual([["A", "B"]]);
    expect(isMovable("AWS::CDK::Metadata")).toBe(false);
  });
});
