import { describe, expect, test } from "bun:test";
import type { Change } from "@aws-sdk/client-cloudformation";
import { fakeCloudFormation, NO_WAIT } from "./migrate-cfn-test-support";
import { needsManualRepair, StackRefactorError } from "./refactor";
import {
  resourcesToRetain,
  retainChangeSetName,
  retainChangesMismatch,
  retainCheckCommands,
  retainResources,
  withRetain,
} from "./retain";
import type { CfnTemplate } from "./templates";

const STACK = "AgentCore-Proj-default";
const DATASET = "ApplicationDatasetGolden8AF7116D";

const deployed: CfnTemplate = {
  Parameters: { BootstrapVersion: { Type: "AWS::SSM::Parameter::Value<String>" } },
  Resources: {
    [DATASET]: {
      Type: "AWS::BedrockAgentCore::Dataset",
      Properties: {
        DatasetName: "Proj_golden",
        KmsKeyArn: { "Fn::GetAtt": ["DatasetKey", "Arn"] },
      },
    },
    DatasetKey: { Type: "AWS::KMS::Key", Properties: {} },
    SharedRole: { Type: "AWS::IAM::Role", Properties: {} },
    Memory: {
      Type: "AWS::BedrockAgentCore::Memory",
      Properties: { RoleArn: { "Fn::GetAtt": ["SharedRole", "Arn"] } },
    },
    CDKMetadata: { Type: "AWS::CDK::Metadata" },
  },
};

describe("resourcesToRetain", () => {
  test("keeps a dropped dataset and what it references that v1 drops too", () => {
    const retained = resourcesToRetain(deployed, new Set([DATASET, "DatasetKey", "CDKMetadata"]));
    expect(retained).toEqual([
      { logicalId: DATASET, type: "AWS::BedrockAgentCore::Dataset", alreadyRetained: false },
      { logicalId: "DatasetKey", type: "AWS::KMS::Key", alreadyRetained: false },
    ]);
  });

  test("leaves references v1 keeps managed", () => {
    // The key stays in the v1 template, so it isn't retained, only the dataset.
    expect(resourcesToRetain(deployed, new Set([DATASET])).map((r) => r.logicalId)).toEqual([
      DATASET,
    ]);
  });

  test("walks references in both directions around a retained knowledge base", () => {
    const knowledgeBase: CfnTemplate = {
      Resources: {
        KnowledgeBase: {
          Type: "AWS::Bedrock::KnowledgeBase",
          Properties: { RoleArn: { "Fn::GetAtt": ["KnowledgeBaseRole", "Arn"] } },
        },
        DataSource: {
          Type: "AWS::Bedrock::DataSource",
          Properties: { KnowledgeBaseId: { Ref: "KnowledgeBase" } },
        },
        KnowledgeBaseRole: { Type: "AWS::IAM::Role", Properties: {} },
        KnowledgeBasePolicy: {
          Type: "AWS::IAM::Policy",
          Properties: { Roles: [{ Ref: "KnowledgeBaseRole" }] },
        },
        Memory: {
          Type: "AWS::BedrockAgentCore::Memory",
          Properties: { RoleArn: { "Fn::GetAtt": ["KnowledgeBaseRole", "Arn"] } },
        },
      },
    };
    const retained = resourcesToRetain(
      knowledgeBase,
      new Set(["KnowledgeBase", "DataSource", "KnowledgeBaseRole", "KnowledgeBasePolicy"]),
    );
    expect(retained.map((resource) => resource.logicalId)).toEqual([
      "DataSource",
      "KnowledgeBase",
      "KnowledgeBasePolicy",
      "KnowledgeBaseRole",
    ]);
  });

  test("retains a dropped insights-only online eval and its dropped support resources", () => {
    const onlineEval: CfnTemplate = {
      Resources: {
        Eval: {
          Type: "AWS::BedrockAgentCore::OnlineEvaluationConfig",
          Properties: { ExecutionRoleArn: { "Fn::GetAtt": ["EvalRole", "Arn"] } },
        },
        EvalRole: { Type: "AWS::IAM::Role", Properties: {} },
        EvalPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: { Roles: [{ Ref: "EvalRole" }] },
        },
      },
    };
    expect(
      resourcesToRetain(onlineEval, new Set(["Eval", "EvalRole", "EvalPolicy"])).map(
        (resource) => resource.logicalId,
      ),
    ).toEqual(["Eval", "EvalPolicy", "EvalRole"]);
  });

  test("retains nothing when v1 drops only other kinds of resources", () => {
    expect(resourcesToRetain(deployed, new Set(["SharedRole", "CDKMetadata"]))).toEqual([]);
  });

  test("notes resources the deployed template already retains", () => {
    const retainedAlready = withRetain(deployed, [DATASET]);
    expect(resourcesToRetain(retainedAlready, new Set([DATASET]))).toEqual([
      { logicalId: DATASET, type: "AWS::BedrockAgentCore::Dataset", alreadyRetained: true },
    ]);
  });
});

describe("withRetain", () => {
  test("sets both retain policies on a copy, changing nothing else", () => {
    const updated = withRetain(deployed, [DATASET]);
    expect(updated.Resources![DATASET]).toEqual({
      ...deployed.Resources![DATASET]!,
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    expect(deployed.Resources![DATASET]!.DeletionPolicy).toBeUndefined();
    expect(updated.Resources!.Memory).toEqual(deployed.Resources!.Memory!);
  });

  test("refuses a resource the template doesn't have", () => {
    expect(() => withRetain(deployed, ["Missing"])).toThrow("'Missing' isn't in the template");
  });
});

const modifyPolicies = (id: string, extra: object[] = []): Change => ({
  Type: "Resource",
  ResourceChange: {
    Action: "Modify",
    LogicalResourceId: id,
    Replacement: "False",
    Details: [
      { Target: { Attribute: "UpdateReplacePolicy", RequiresRecreation: "Never" } },
      { Target: { Attribute: "DeletionPolicy", RequiresRecreation: "Never" } },
      ...extra,
    ],
  },
});

describe("retainChangesMismatch", () => {
  test("accepts only the retain policies on the expected resources", () => {
    expect(retainChangesMismatch([modifyPolicies(DATASET)], new Set([DATASET]))).toBeUndefined();
  });

  test("names property changes, other resources, replacements, and missing changes", () => {
    const problems = retainChangesMismatch(
      [
        modifyPolicies(DATASET, [{ Target: { Attribute: "Properties", Name: "DatasetName" } }]),
        {
          Type: "Resource",
          ResourceChange: { Action: "Modify", LogicalResourceId: "Memory" },
        } as Change,
        {
          Type: "Resource",
          ResourceChange: { Action: "Modify", LogicalResourceId: "Key", Replacement: "True" },
        } as Change,
      ],
      new Set([DATASET, "Key", "Other"]),
    );
    expect(problems).toContain(`${DATASET} changes Properties DatasetName`);
    expect(problems).toContain("unexpected Modify of Memory");
    expect(problems).toContain("Key would be replaced");
    expect(problems).toContain("no change to Other");
  });
});

function retainStack(client: ReturnType<typeof fakeCloudFormation>["client"]) {
  return {
    stackName: STACK,
    region: "us-east-1",
    template: withRetain(deployed, [DATASET]),
    logicalIds: new Set([DATASET]),
    client,
    templates: async () => ({
      put: async () => {
        throw new Error("a small template must not be uploaded");
      },
      remove: async () => {},
    }),
  };
}

const describedStack = (status: string) => ({
  Stacks: [
    {
      StackName: STACK,
      StackStatus: status,
      Parameters: [{ ParameterKey: "BootstrapVersion", ParameterValue: "/cdk-bootstrap/v" }],
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    },
  ],
});

const retainedTemplate = { TemplateBody: JSON.stringify(withRetain(deployed, [DATASET])) };

describe("retainResources", () => {
  test("creates a change set reusing parameters and capabilities, checks it, and executes it", async () => {
    const created: string[] = [];
    const { client, sent } = fakeCloudFormation({
      DescribeStacks: [
        describedStack("CREATE_COMPLETE"),
        describedStack("UPDATE_IN_PROGRESS"),
        describedStack("UPDATE_COMPLETE"),
      ],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [
        { Status: "CREATE_IN_PROGRESS" },
        { Status: "CREATE_COMPLETE", Changes: [modifyPolicies(DATASET)] },
      ],
      ExecuteChangeSet: [{}],
      GetTemplate: [retainedTemplate],
      DeleteChangeSet: [{}],
    });

    await retainResources(retainStack(client), {
      ...NO_WAIT,
      changeSetName: "agentcore-migrate-retain-1",
      onCreated: async (name) => {
        created.push(name);
      },
    });

    expect(created).toEqual(["agentcore-migrate-retain-1"]);
    const create = sent.find((command) => command.name === "CreateChangeSet")!;
    expect(create.input.ChangeSetType).toBe("UPDATE");
    expect(create.input.Parameters).toEqual([
      { ParameterKey: "BootstrapVersion", UsePreviousValue: true },
    ]);
    expect(create.input.Capabilities).toEqual(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
    const body = JSON.parse(create.input.TemplateBody as string) as CfnTemplate;
    expect(body.Resources![DATASET]!.DeletionPolicy).toBe("Retain");
    expect(sent.some((command) => command.name === "ExecuteChangeSet")).toBe(true);
    expect(sent.some((command) => command.name === "DeleteChangeSet")).toBe(true);
  });

  test("does not report a change set ID when creating it failed before one existed", async () => {
    const { client } = fakeCloudFormation({
      DescribeStacks: [describedStack("CREATE_COMPLETE")],
      CreateChangeSet: [new Error("network unavailable")],
    });

    const error = await retainResources(retainStack(client), {
      ...NO_WAIT,
      changeSetName: "never-created",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StackRefactorError);
    expect((error as StackRefactorError).details).toEqual({
      kind: "create-failed",
      stackName: STACK,
      region: "us-east-1",
    });
  });

  test("deletes a change set that does more than set retain policies, without executing it", async () => {
    const { client, sent } = fakeCloudFormation({
      DescribeStacks: [describedStack("CREATE_COMPLETE")],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [
        {
          Status: "CREATE_COMPLETE",
          Changes: [
            modifyPolicies(DATASET, [{ Target: { Attribute: "Properties", Name: "DatasetName" } }]),
          ],
        },
      ],
      DeleteChangeSet: [{}],
    });

    const error = await retainResources(retainStack(client), NO_WAIT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StackRefactorError);
    expect((error as StackRefactorError).details.kind).toBe("create-failed");
    expect((error as Error).message).toContain("would do more than set their retain policies");
    expect(sent.some((command) => command.name === "ExecuteChangeSet")).toBe(false);
    expect(sent.some((command) => command.name === "DeleteChangeSet")).toBe(true);
  });

  test("a change set CloudFormation refuses to execute leaves the stack unchanged", async () => {
    const refused = Object.assign(new Error("ValidationError"), {
      $metadata: { httpStatusCode: 400 },
    });
    const { client } = fakeCloudFormation({
      DescribeStacks: [describedStack("CREATE_COMPLETE")],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", Changes: [modifyPolicies(DATASET)] }],
      ExecuteChangeSet: [refused],
      DeleteChangeSet: [{}],
    });

    const error = await retainResources(retainStack(client), NO_WAIT).catch((e: unknown) => e);

    expect((error as StackRefactorError).details.kind).toBe("execute-failed");
    expect(needsManualRepair(error)).toBe(false);
  });

  test("an execute call that fails without CloudFormation's answer is an unknown outcome", async () => {
    const { client } = fakeCloudFormation({
      DescribeStacks: [describedStack("CREATE_COMPLETE")],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", Changes: [modifyPolicies(DATASET)] }],
      ExecuteChangeSet: [new Error("socket hang up")],
    });

    const error = await retainResources(retainStack(client), {
      ...NO_WAIT,
      changeSetName: "cs-1",
    }).catch((e: unknown) => e);

    expect(needsManualRepair(error)).toBe(true);
    expect((error as StackRefactorError).details.refactorId).toBe("cs-1");
  });

  test("an update that rolls back leaves the stack as it was", async () => {
    const { client } = fakeCloudFormation({
      DescribeStacks: [
        describedStack("CREATE_COMPLETE"),
        describedStack("UPDATE_ROLLBACK_COMPLETE"),
      ],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", Changes: [modifyPolicies(DATASET)] }],
      ExecuteChangeSet: [{}],
    });

    const error = await retainResources(retainStack(client), NO_WAIT).catch((e: unknown) => e);

    expect((error as StackRefactorError).details.kind).toBe("execute-failed");
    expect((error as Error).message).toContain("rolled back, so the stack is unchanged");
  });

  test("an update that finished without the retain policies in place is an unknown outcome", async () => {
    const { client } = fakeCloudFormation({
      DescribeStacks: [describedStack("CREATE_COMPLETE"), describedStack("UPDATE_COMPLETE")],
      CreateChangeSet: [{ Id: "cs-arn" }],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", Changes: [modifyPolicies(DATASET)] }],
      ExecuteChangeSet: [{}],
      GetTemplate: [{ TemplateBody: JSON.stringify(deployed) }],
    });

    const error = await retainResources(retainStack(client), NO_WAIT).catch((e: unknown) => e);

    expect(needsManualRepair(error)).toBe(true);
    expect((error as Error).message).toContain(`doesn't retain ${DATASET}`);
  });
});

test("retainChangeSetName is unique per second and a valid change set name", () => {
  expect(retainChangeSetName(new Date("2026-10-14T16:27:30.123Z"))).toBe(
    "agentcore-migrate-retain-20261014162730",
  );
});

test("retainCheckCommands names the change set and the stack", () => {
  expect(retainCheckCommands(STACK, "us-east-1", "cs-1")).toEqual([
    `aws cloudformation describe-change-set --stack-name ${STACK} --change-set-name cs-1 --region us-east-1`,
    `aws cloudformation describe-stacks --stack-name ${STACK} --region us-east-1`,
  ]);
});
