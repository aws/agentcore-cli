import { describe, expect, test } from "bun:test";
import type { PinnedName } from "../../../handlers/project/migrate/types";
import { templateFixture } from "./migrate-test-support";
import { chainedRenames, planStack, stackBlockerCount } from "./plan";
import { deployImpact } from "./replacements";
import type { CfnTemplate } from "./templates";

const target = { name: "default", account: "123456789012", region: "us-east-1" as const };
const STACK = "AgentCore-CompatMig-default";

const plan = async (deployed: string, v1: string, v1StackName = STACK, pins: PinnedName[] = []) =>
  planStack({
    target,
    stackName: STACK,
    v1StackName,
    deployed: templateFixture(deployed),
    v1: templateFixture(v1),
    pins,
  });

describe("planStack with a dataset v1 has no counterpart for", () => {
  const DATASET = "ApplicationDatasetGolden8AF7116D";
  const withDataset = (): CfnTemplate => {
    const deployed = templateFixture("pinned.v0");
    deployed.Resources![DATASET] = {
      Type: "AWS::BedrockAgentCore::Dataset",
      Properties: {
        DatasetName: "CompatMig_golden",
        SchemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
      },
    };
    return deployed;
  };
  const planWith = (deployed: CfnTemplate) =>
    planStack({
      target,
      stackName: STACK,
      v1StackName: STACK,
      deployed,
      v1: templateFixture("pinned.v1"),
      pins: [],
    });

  test("is retained first, then refactored and left in the account", async () => {
    const { plan: stack, retain, bridge } = await planWith(withDataset());
    expect(stack.ready).toBe(true);
    expect(stack.retained).toEqual([
      { logicalId: DATASET, type: "AWS::BedrockAgentCore::Dataset" },
    ]);
    expect([...retain!.logicalIds]).toEqual([DATASET]);
    expect(retain!.template.Resources![DATASET]).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    // The refactor starts from the retained stack, so its template must carry the policies.
    expect(bridge!.Resources![DATASET]!.DeletionPolicy).toBe("Retain");
    const removed = stack.removed.find((change) => change.logicalId === DATASET)!;
    expect(removed.severity).toBe("info");
    expect(removed.reason).toContain("leaves it, and its data, in the account outside the stack");
  });

  test("a dataset the stack already retains needs no update, only the refactor", async () => {
    const deployed = withDataset();
    deployed.Resources![DATASET]!.DeletionPolicy = "Retain";
    deployed.Resources![DATASET]!.UpdateReplacePolicy = "Retain";
    const { plan: stack, retain } = await planWith(deployed);
    expect(stack.ready).toBe(true);
    expect(retain).toBeUndefined();
    expect(stack.retained).toHaveLength(1);
  });
});

describe("planStack with knowledge bases and insights-only online evals", () => {
  test("retains each resource and the dropped resources connected to it", async () => {
    const deployed = templateFixture("pinned.v0");
    Object.assign(deployed.Resources!, {
      KnowledgeBase: {
        Type: "AWS::Bedrock::KnowledgeBase",
        Properties: { RoleArn: { "Fn::GetAtt": ["KnowledgeBaseRole", "Arn"] } },
      },
      KnowledgeBaseDataSource: {
        Type: "AWS::Bedrock::DataSource",
        Properties: { KnowledgeBaseId: { Ref: "KnowledgeBase" } },
      },
      KnowledgeBaseRole: {
        Type: "AWS::IAM::Role",
        Properties: { AssumeRolePolicyDocument: { Statement: [] } },
      },
      KnowledgeBasePolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          Roles: [{ Ref: "KnowledgeBaseRole" }],
          PolicyDocument: { Statement: [] },
        },
      },
      InsightsEval: {
        Type: "AWS::BedrockAgentCore::OnlineEvaluationConfig",
        Properties: { ExecutionRoleArn: { "Fn::GetAtt": ["InsightsRole", "Arn"] } },
      },
      InsightsRole: {
        Type: "AWS::IAM::Role",
        Properties: { AssumeRolePolicyDocument: { Statement: [] } },
      },
      InsightsPolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          Roles: [{ Ref: "InsightsRole" }],
          PolicyDocument: { Statement: [] },
        },
      },
    });

    const { plan: stack, retain } = await planStack({
      target,
      stackName: STACK,
      v1StackName: STACK,
      deployed,
      v1: templateFixture("pinned.v1"),
      pins: [],
    });

    const expected = [
      "InsightsEval",
      "InsightsPolicy",
      "InsightsRole",
      "KnowledgeBase",
      "KnowledgeBaseDataSource",
      "KnowledgeBasePolicy",
      "KnowledgeBaseRole",
    ];
    expect(stack.ready).toBe(true);
    expect(stack.retained?.map((resource) => resource.logicalId)).toEqual(expected);
    expect([...retain!.logicalIds]).toEqual(expected);
    expect(
      stack.removed
        .filter((change) => expected.includes(change.logicalId))
        .every((change) => change.severity === "info"),
    ).toBe(true);
  });
});

describe("planStack", () => {
  test("the live CompatMig stack with pinned names: 10 moves and 0 replacements", async () => {
    const { plan: stack, bridge, renames } = await plan("pinned.v0", "pinned.v1");
    expect(stack).toMatchObject({
      target: "default",
      account: "123456789012",
      region: "us-east-1",
      stackName: STACK,
      unchanged: 5,
      added: [],
      replaced: [],
      blockers: [],
      ready: true,
    });
    expect(stack.moves).toContainEqual({
      type: "AWS::BedrockAgentCore::Memory",
      from: "ApplicationMemoryMigagentMemoryCA18A787",
      to: "ApplicationMemoryMigagentMemoryMemoryA587350B",
    });
    expect(stack.moves).toHaveLength(10);
    // v1's gateway role has no DefaultPolicy; the deploy deletes v0's.
    expect(stack.removed).toEqual([
      {
        logicalId: "McpGatewayMiggwRoleDefaultPolicy403FA543",
        type: "AWS::IAM::Policy",
        severity: "warning",
        reason: "the v1 template has no counterpart, so the v1 deploy deletes it",
      },
    ]);
    expect(renames.size).toBe(10);
    expect(Object.keys(bridge!.Resources!)).toContain("ApplicationRuntimeMigagentRuntime93E3CAC2");
  });

  test("a library without pinned names replaces the config bundle: a blocker", async () => {
    const { plan: stack } = await plan("codezip.v0", "codezip.v1-rc3");
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([]);
    expect(stack.replaced).toEqual([
      {
        logicalId: "ApplicationEvaluatorRefcodeFunctionBedrockAgentCoreEvaluatorInvokeE8AA0D2E",
        type: "AWS::Lambda::Permission",
        severity: "warning",
        reason:
          "the v1 deploy replaces it because SourceAccount, SourceArn change; resources that use it are updated to the new one",
      },
      {
        logicalId: "ApplicationConfigBundleRefcb9FCFB8E4",
        type: "AWS::BedrockAgentCore::ConfigurationBundle",
        severity: "blocker",
        reason:
          "the v1 deploy replaces it because BundleName changes; its ID, ARN, and data would be lost",
      },
    ]);
  });

  test("container project: AgentCore and ECR repository renames are blockers", async () => {
    const { plan: stack } = await plan("container.v0", "container.v1-v1names");
    const bySeverity = (severity: string) =>
      stack.replaced.filter((change) => change.severity === severity).map((change) => change.type);
    expect(bySeverity("warning")).toEqual([]);
    expect(bySeverity("blocker")).toEqual([
      "AWS::BedrockAgentCore::Memory",
      "AWS::BedrockAgentCore::Evaluator",
      "AWS::BedrockAgentCore::PolicyEngine",
      "AWS::BedrockAgentCore::Policy",
      "AWS::ECR::Repository",
      "AWS::BedrockAgentCore::Runtime",
      "AWS::BedrockAgentCore::ConfigurationBundle",
      "AWS::BedrockAgentCore::OnlineEvaluationConfig",
    ]);
    // The build trigger can't move, so it's recreated: expected, not a warning.
    expect(stack.removed.find((change) => change.type.includes("CustomResource"))).toMatchObject({
      severity: "info",
    });
    expect(stack.added).toEqual([
      {
        logicalId: "ApplicationRuntimeMyagentContainerImageBuilderContainerBuildTriggerC9AB9871",
        type: "AWS::CloudFormation::CustomResource",
      },
    ]);
  });

  test("says v0 naming didn't reproduce a kept name when that's why a resource is replaced", async () => {
    // container.v1-v1names was synthesized by a library that composes v1 names, as one
    // that doesn't honor migratedFrom for a kind of resource would.
    const runtime = Object.values(templateFixture("container.v0").Resources ?? {}).find(
      (resource) => resource.Type === "AWS::BedrockAgentCore::Runtime",
    )?.Properties?.AgentRuntimeName as string;
    const { plan: stack } = await plan("container.v0", "container.v1-v1names", STACK, [
      { resourceType: "runtime", name: "myagent", value: runtime, targets: ["default"] },
    ]);
    const replaced = stack.replaced.find(
      (change) => change.type === "AWS::BedrockAgentCore::Runtime",
    );
    expect(replaced).toMatchObject({ severity: "blocker" });
    expect(replaced?.reason).toMatch(
      new RegExp(
        `^v0 naming doesn't reproduce runtime 'myagent' \\(deployed as '${runtime}', v1 renders '[^']+'\\), so the v1 deploy would replace it\\.`,
      ),
    );
    // Resources without a recorded name keep the generic reason.
    expect(
      stack.replaced.find((change) => change.type === "AWS::BedrockAgentCore::Memory")?.reason,
    ).toStartWith("the v1 deploy replaces it");
    expect(stack.ready).toBe(false);
  });

  test("a live v0 container project (SrWalkD, deployed by v0 0.31.1) plans Ready", async () => {
    // Deployed with its aws:cdk:path metadata: the library's ContainerBuildProject sits at the
    // stack root, beside Application and Mcp.
    const deployed = templateFixture("container-live.v0");
    expect(
      Object.values(deployed.Resources ?? {}).some((resource) =>
        String((resource.Metadata as Record<string, unknown>)["aws:cdk:path"]).includes(
          "/ContainerBuildProject/",
        ),
      ),
    ).toBe(true);
    const { plan: stack } = await planStack({
      target,
      stackName: "AgentCore-SrWalkD-default",
      v1StackName: "AgentCore-SrWalkD-default",
      deployed,
      // Synthesized by migrate's planner with a library that keeps v0 names (migratedFrom).
      v1: templateFixture("container-live.v1"),
      pins: [],
    });
    expect(stack.blockers).toEqual([]);
    expect(stack.moves).toHaveLength(14);
    expect(stack.replaced).toEqual([]);
    expect(stack.ready).toBe(true);
  });

  test("a v1 stack name that differs from the deployed one is a blocker", async () => {
    const { plan: stack } = await plan("pinned.v0", "pinned.v1", "AgentCore-Other-default");
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      `The v1 app names this target's stack 'AgentCore-Other-default', not '${STACK}', so a v1 deploy would create a new stack instead of updating this one.`,
    ]);
  });

  const planOf = (deployed: CfnTemplate, v1: CfnTemplate) =>
    planStack({ target, stackName: STACK, v1StackName: STACK, deployed, v1, pins: [] });

  test("nested stacks are a blocker", async () => {
    const nested = { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "u" } };
    const { plan: stack } = await planOf(
      { Resources: { Child: nested } },
      { Resources: { Child: nested } },
    );
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      "The stack has nested stacks (Child), which the v0 CDK app doesn't create and migrate can't plan.",
    ]);
  });

  test("resources outside the v0 app's constructs are a blocker", async () => {
    const bucket = {
      Type: "AWS::S3::Bucket",
      Metadata: { "aws:cdk:path": `${STACK}/Uploads/Resource` },
    };
    const { plan: stack } = await planOf(
      { Resources: { Uploads: bucket } },
      { Resources: { Uploads: bucket } },
    );
    expect(stack.ready).toBe(false);
    expect(stack.blockers[0]).toStartWith(
      `The deployed stack has resources the v0 CDK app doesn't create: Uploads (AWS::S3::Bucket, ${STACK}/Uploads/Resource).`,
    );
  });

  test("chained or swapped renames are a blocker", async () => {
    expect(
      chainedRenames(
        new Map([
          ["A", "B"],
          ["B", "A"],
          ["C", "D"],
        ]),
      ),
    ).toEqual(["A → B", "B → A"]);
    // Two named runtimes whose v1 logical IDs are each other's deployed ones.
    const runtime = (name: string) => ({
      Type: "AWS::BedrockAgentCore::Runtime",
      Properties: { AgentRuntimeName: name },
    });
    const { plan: stack } = await planOf(
      { Resources: { X: runtime("p_a"), Y: runtime("p_b") } },
      { Resources: { Y: runtime("p_a"), X: runtime("p_b") } },
    );
    expect(stack.moves).toHaveLength(2);
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      "The refactor would rename into logical IDs it also renames away from (X → Y, Y → X). Chained and swapped renames haven't been verified with CloudFormation stack refactoring, so migrate doesn't attempt them.",
    ]);
  });

  test("a gateway ProtocolType change is a blocker; keeping v0's (none) is clean", async () => {
    const gateway = (extra: Record<string, unknown>) => ({
      Type: "AWS::BedrockAgentCore::Gateway",
      Properties: { Name: "P-gw", AuthorizerType: "NONE", ...extra },
    });
    const clean = await planOf(
      { Resources: { Gw: gateway({}) } },
      { Resources: { Gw: gateway({}) } },
    );
    expect(clean.plan).toMatchObject({ ready: true, updated: [] });

    const changed = await planOf(
      { Resources: { Gw: gateway({}) } },
      { Resources: { Gw: gateway({ ProtocolType: "MCP" }) } },
    );
    expect(changed.plan.ready).toBe(false);
    expect(changed.plan.updated).toMatchObject([{ logicalId: "Gw", severity: "blocker" }]);
    expect(stackBlockerCount(changed.plan)).toBe(1);
  });

  test("a bridge that can't be built is a blocker", async () => {
    // v1 moves the role to an ID the deployed template keeps for a topic v1 drops.
    const deployed: CfnTemplate = {
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: { RoleName: "r" } },
        Taken: { Type: "AWS::SNS::Topic", Properties: {} },
      },
    };
    const v1: CfnTemplate = {
      Resources: { Taken: { Type: "AWS::IAM::Role", Properties: { RoleName: "r" } } },
    };
    const { plan: stack, bridge } = await planStack({
      target,
      stackName: STACK,
      v1StackName: STACK,
      deployed,
      v1,
      pins: [],
    });
    expect(bridge).toBeUndefined();
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      "Couldn't build the refactor template: Can't rename 'Role' to 'Taken': the deployed AWS::SNS::Topic 'Taken' keeps that logical ID.",
    ]);
  });
});

describe("deployImpact", () => {
  const resource = (Type: string, Properties: Record<string, unknown> = {}, extra = {}) => ({
    Type,
    Properties,
    ...extra,
  });

  test("classifies deletions: AgentCore, stateful, and unknown types block; retained is info; stateless warns", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Memory: resource("AWS::BedrockAgentCore::Memory", { Name: "m", EventExpiryDuration: 30 }),
          Logs: resource("AWS::Logs::LogGroup", {}, { DeletionPolicy: "Retain" }),
          Topic: resource("AWS::SNS::Topic"),
          Role: resource("AWS::IAM::Role", { AssumeRolePolicyDocument: {} }),
          Keep: resource("AWS::SNS::Topic"),
        },
      },
      { Resources: { Keep: resource("AWS::SNS::Topic"), New: resource("AWS::SNS::Topic") } },
    );
    expect(impact.added).toEqual([{ logicalId: "New", type: "AWS::SNS::Topic" }]);
    expect(impact.removed.map((change) => [change.logicalId, change.severity])).toEqual([
      ["Memory", "blocker"],
      ["Logs", "info"],
      ["Topic", "blocker"],
      ["Role", "warning"],
    ]);
    expect(impact.removed[2]?.reason).toContain("migrate can't tell whether this type holds data");
    expect(impact.replaced).toEqual([]);
  });

  test("deleting an un-retained stateful resource blocks; retaining it doesn't", async () => {
    const stateful = {
      Bucket: resource("AWS::S3::Bucket"),
      Table: resource("AWS::DynamoDB::Table", { KeySchema: [] }),
      Key: resource("AWS::KMS::Key", { KeyPolicy: {} }),
      Logs: resource("AWS::Logs::LogGroup"),
      Secret: resource("AWS::SecretsManager::Secret"),
      Db: resource("AWS::RDS::DBInstance"),
      Fs: resource("AWS::EFS::FileSystem"),
      // Snapshot keeps a backup, but the resource itself is deleted.
      Snap: resource("AWS::RDS::DBCluster", {}, { DeletionPolicy: "Snapshot" }),
    };
    const impact = await deployImpact({ Resources: stateful }, { Resources: {} });
    expect(impact.removed.every((change) => change.severity === "blocker")).toBe(true);
    expect(impact.removed).toHaveLength(Object.keys(stateful).length);
    const reason = impact.removed.find((change) => change.logicalId === "Bucket")?.reason;
    expect(reason).toStartWith(
      "the v1 template has no counterpart, so the v1 deploy would delete it and its data. To keep it: ",
    );
    // The order that works: retention is read from the deployed template.
    expect(reason).toContain(
      "1. set its removal policy to retain in agentcore/cdk/lib/cdk-stack.ts",
    );
    expect(reason).toContain(
      "2. run agentcore deploy (it deploys a v0 project with the v0 CLI), 3. undo the change to cdk-stack.ts, " +
        "4. run agentcore migrate again",
    );
    expect(impact.removed.find((change) => change.logicalId === "Snap")?.reason).toContain(
      "(DeletionPolicy: Snapshot keeps only a final snapshot)",
    );

    const retained = await deployImpact(
      { Resources: { Bucket: resource("AWS::S3::Bucket", {}, { DeletionPolicy: "Retain" }) } },
      { Resources: {} },
    );
    expect(retained.removed).toMatchObject([{ logicalId: "Bucket", severity: "info" }]);
  });

  test("replacing a stateful resource blocks, saying what its UpdateReplacePolicy does", async () => {
    const table = (name: string, policy?: string) =>
      resource(
        "AWS::DynamoDB::Table",
        { TableName: name, KeySchema: [] },
        policy === undefined ? {} : { UpdateReplacePolicy: policy },
      );
    const reasonFor = async (policy?: string) =>
      (
        await deployImpact(
          { Resources: { T: table("a", policy) } },
          { Resources: { T: table("b") } },
        )
      ).replaced[0];
    expect(await reasonFor()).toMatchObject({
      severity: "blocker",
      reason:
        "the v1 deploy replaces it because TableName changes; the new one starts empty, and the deployed one is deleted with its data",
    });
    expect((await reasonFor("Retain"))?.reason).toEndWith(
      "the new one starts empty, and the deployed one is left in the account outside the stack (UpdateReplacePolicy: Retain), unused",
    );
    expect((await reasonFor("Snapshot"))?.reason).toEndWith(
      "the new one starts empty, and the deployed one is deleted after a final snapshot (UpdateReplacePolicy: Snapshot)",
    );
  });

  test("replacing a resource that keeps its custom name blocks: CloudFormation can't do it", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Fn: resource("AWS::Lambda::Function", {
            FunctionName: "P-eval-a",
            PackageType: "Zip",
            Role: "r",
          }),
        },
      },
      {
        Resources: {
          Fn: resource("AWS::Lambda::Function", {
            FunctionName: "P-eval-a",
            PackageType: "Image",
            Role: "r",
          }),
        },
      },
    );
    expect(impact.replaced).toMatchObject([
      {
        logicalId: "Fn",
        severity: "blocker",
        reason:
          "the v1 deploy replaces it because PackageType changes; CloudFormation can't replace a resource that keeps its custom name ('P-eval-a'), so the deploy would fail",
      },
    ]);
  });

  test("a deleted resource whose name a new one takes blocks: the create would fail", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Old: resource("AWS::Lambda::Function", { FunctionName: "P-tool", Role: "r" }),
        },
      },
      {
        Resources: {
          New: resource("AWS::Lambda::Function", { FunctionName: "P-tool", Role: "r" }),
        },
      },
    );
    expect(impact.removed).toMatchObject([
      {
        logicalId: "Old",
        severity: "blocker",
        reason:
          "the v1 deploy creates New with the same name 'P-tool' while this one still holds it, so the create fails; the mapping couldn't pair the two",
      },
    ]);
  });

  test("lists in-place updates of AgentCore resources, blocking ones the service rejects", async () => {
    const gateway = (properties: Record<string, unknown>) =>
      resource("AWS::BedrockAgentCore::Gateway", {
        Name: "P-gw",
        AuthorizerType: "NONE",
        RoleArn: "arn:aws:iam::1:role/r",
        ...properties,
      });
    const memory = (description: string) =>
      resource("AWS::BedrockAgentCore::Memory", { Name: "m", Description: description });

    // A v0 protocolType "None" gateway has no ProtocolType; v1 keeping it that way is clean.
    const kept = await deployImpact(
      { Resources: { Gw: gateway({}) } },
      { Resources: { Gw: gateway({}) } },
    );
    expect(kept.updated).toEqual([]);

    const changed = await deployImpact(
      { Resources: { Gw: gateway({}), Mem: memory("a") } },
      { Resources: { Gw: gateway({ ProtocolType: "MCP" }), Mem: memory("b") } },
    );
    expect(changed.replaced).toEqual([]);
    expect(changed.updated).toEqual([
      {
        logicalId: "Gw",
        type: "AWS::BedrockAgentCore::Gateway",
        severity: "blocker",
        reason:
          'the v1 deploy changes ProtocolType from (unset) to "MCP", which the service doesn\'t allow on an existing resource, so the deploy would fail and roll back. Set the matching field in agentcore.json so v1 keeps the deployed value (for a gateway: protocolType "None" when ProtocolType is unset, and authorizerType to the deployed AuthorizerType)',
      },
      {
        logicalId: "Mem",
        type: "AWS::BedrockAgentCore::Memory",
        severity: "warning",
        reason: "the v1 deploy updates it in place: Description changes",
      },
    ]);
  });

  test("names the properties that force a replacement, and ignores in-place updates", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Runtime: resource("AWS::BedrockAgentCore::Runtime", {
            AgentRuntimeName: "a",
            Description: "x",
          }),
          Repo: resource("AWS::ECR::Repository", { RepositoryName: "p/a" }),
        },
      },
      {
        Resources: {
          Runtime: resource("AWS::BedrockAgentCore::Runtime", {
            AgentRuntimeName: "a",
            Description: "y",
          }),
          Repo: resource("AWS::ECR::Repository", { RepositoryName: "p/default/a" }),
        },
      },
    );
    expect(impact.replaced).toEqual([
      {
        logicalId: "Repo",
        type: "AWS::ECR::Repository",
        severity: "blocker",
        reason:
          "the v1 deploy replaces it because RepositoryName changes; its images and repository URI would be lost",
      },
    ]);
  });

  test("follows a replacement to what reads the replaced resource's ID in a create-only property", async () => {
    const before: CfnTemplate = {
      Resources: {
        Fn: resource("AWS::Lambda::Function", { FunctionName: "eval-a", Role: "r" }),
        Invoke: resource("AWS::Lambda::Permission", {
          Action: "lambda:InvokeFunction",
          Principal: "bedrock-agentcore.amazonaws.com",
          FunctionName: { "Fn::GetAtt": ["Fn", "Arn"] },
        }),
        Logs: resource("AWS::Logs::LogGroup", { LogGroupName: { "Fn::Sub": "/aws/lambda/${Fn}" } }),
        // Reads the function's name in a property that updates in place.
        Topic: resource("AWS::SNS::Topic", { DisplayName: { Ref: "Fn" } }),
      },
    };
    const after = structuredClone(before);
    after.Resources!.Fn!.Properties!.FunctionName = "eval-b";
    const impact = await deployImpact(before, after);
    expect(impact.replaced.map((change) => change.logicalId)).toEqual(["Fn", "Invoke", "Logs"]);
    // The diff itself follows Fn::GetAtt to a replaced resource; the Fn::Sub
    // reference is found by probing the log group with Fn's ID changed.
    expect(impact.replaced[1]?.reason).toBe(
      "the v1 deploy replaces it because FunctionName changes; resources that use it are updated to the new one",
    );
    // A log group holds data, so losing it to the cascade blocks.
    expect(impact.replaced[2]).toMatchObject({
      severity: "blocker",
      reason:
        "the v1 deploy replaces it because it references Fn, which is replaced; the new one starts empty, and the deployed one is deleted with its data",
    });
  });

  test("a logical ID that changes type always blocks, even for a stateless type", async () => {
    const impact = await deployImpact(
      { Resources: { X: resource("AWS::IAM::Policy", { PolicyDocument: {}, PolicyName: "p" }) } },
      { Resources: { X: resource("AWS::IAM::Role", { AssumeRolePolicyDocument: {} }) } },
    );
    expect(impact.removed).toEqual([
      {
        logicalId: "X",
        type: "AWS::IAM::Policy",
        severity: "blocker",
        reason:
          "the v1 template declares a AWS::IAM::Role under this logical ID; CloudFormation can't change a resource's type under one logical ID, so the deploy would fail",
      },
    ]);
  });

  test("a logical ID v1 reuses for another type deletes the deployed resource", async () => {
    const impact = await deployImpact(
      { Resources: { X: resource("AWS::BedrockAgentCore::Runtime", { AgentRuntimeName: "a" }) } },
      { Resources: { X: resource("AWS::IAM::Role", { AssumeRolePolicyDocument: {} }) } },
    );
    expect(impact.removed).toMatchObject([
      { logicalId: "X", type: "AWS::BedrockAgentCore::Runtime", severity: "blocker" },
    ]);
    expect(impact.added).toEqual([{ logicalId: "X", type: "AWS::IAM::Role" }]);
    expect(impact.replaced).toEqual([]);
  });

  test("a retained AgentCore resource, a harness role, and an unknown custom resource", async () => {
    const harness = (role: string) =>
      resource("AWS::BedrockAgentCore::Harness", {
        HarnessName: "h",
        ExecutionRoleArn: { "Fn::GetAtt": [role, "Arn"] },
      });
    const impact = await deployImpact(
      {
        Resources: {
          Memory: resource(
            "AWS::BedrockAgentCore::Memory",
            { Name: "m" },
            { DeletionPolicy: "Retain" },
          ),
          Role: resource("AWS::IAM::Role", { RoleName: "P_h", AssumeRolePolicyDocument: {} }),
          Harness: harness("Role"),
          Hook: resource("Custom::Something", { ServiceToken: "arn" }),
        },
      },
      {
        Resources: {
          Role: resource("AWS::IAM::Role", {
            RoleName: "P_default_h",
            AssumeRolePolicyDocument: {},
          }),
          Harness: harness("Role"),
        },
      },
    );
    expect(impact.removed.map((change) => [change.logicalId, change.severity])).toEqual([
      ["Memory", "blocker"],
      ["Hook", "warning"],
    ]);
    expect(impact.replaced.find((change) => change.logicalId === "Role")).toMatchObject({
      severity: "blocker",
      reason:
        "the v1 deploy replaces it because RoleName changes; the harness's role would get a new name and ARN",
    });
  });
});
