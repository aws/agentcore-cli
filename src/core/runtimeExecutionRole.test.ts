import { describe, expect, test } from "bun:test";
import type { IAMClient } from "@aws-sdk/client-iam";
import { InputValidationError } from "../errors";
import {
  CREATED_BY_TAG,
  RUNTIME_TAG_KEY,
  deleteRuntimeExecutionRole,
  ensureRuntimeExecutionRole,
  refreshRuntimeExecutionRolePolicy,
  runtimeExecutionPolicy,
  runtimeExecutionRoleName,
} from "./runtimeExecutionRole";

const ACCOUNT = "111122223333";
const NAME = "my_agent";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/AgentCoreRuntime-${NAME}`;
const PRIVATE_IMAGE = `444455556666.dkr.ecr.eu-west-1.amazonaws.com/team/agent:v1`;
const CLI_TAGS = [{ ...CREATED_BY_TAG }, { Key: RUNTIME_TAG_KEY, Value: NAME }];

type Statement = { Sid: string; Action: string | string[]; Resource: string | string[] };
function statements(policy: string): Statement[] {
  return (JSON.parse(policy) as { Statement: Statement[] }).Statement;
}

// fakeIam answers each command by name and records what was sent.
function fakeIam(answers: Record<string, (input: any) => unknown>) {
  const sent: { name: string; input: any }[] = [];
  const iam = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected ${name}`);
      return answer(command.input);
    },
  } as unknown as IAMClient;
  return { iam, sent, names: () => sent.map((entry) => entry.name) };
}

function noSuchEntity(): never {
  const error = new Error("not found");
  error.name = "NoSuchEntityException";
  throw error;
}

describe("runtimeExecutionPolicy", () => {
  test("allows pull from exactly the image's repository and logs for this runtime", () => {
    const policy = statements(runtimeExecutionPolicy("us-west-2", ACCOUNT, NAME, PRIVATE_IMAGE));
    expect(policy.find((s) => s.Sid === "EcrImagePull")).toEqual({
      Sid: "EcrImagePull",
      Effect: "Allow",
      Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      Resource: "arn:aws:ecr:eu-west-1:444455556666:repository/team/agent",
    } as Statement);
    expect(policy.find((s) => s.Sid === "CloudWatchLogsStream")?.Resource).toBe(
      `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/${NAME}-*:log-stream:*`,
    );
    // Only GetAuthorizationToken, which IAM cannot scope, uses a wildcard.
    const wildcards = policy.filter((s) => s.Resource === "*").map((s) => s.Action);
    expect(wildcards).toEqual([["ecr:GetAuthorizationToken"]]);
    expect(policy.flatMap((s) => s.Action)).not.toContain("bedrock:InvokeModel");
  });

  test("grants no ECR permissions for a public.ecr.aws image", () => {
    const policy = statements(
      runtimeExecutionPolicy("us-west-2", ACCOUNT, NAME, "public.ecr.aws/example/agent:latest"),
    );
    expect(policy.map((s) => s.Sid)).toEqual(["CloudWatchLogsGroup", "CloudWatchLogsStream"]);
  });

  test("uses the aws-cn partition in China regions", () => {
    const policy = runtimeExecutionPolicy(
      "cn-north-1",
      ACCOUNT,
      NAME,
      `${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn/agent:v1`,
    );
    expect(policy).toContain(`arn:aws-cn:ecr:cn-north-1:${ACCOUNT}:repository/agent`);
    expect(policy).toContain("arn:aws-cn:logs:cn-north-1:");
  });
});

describe("ensureRuntimeExecutionRole", () => {
  test("creates a tagged role trusting AgentCore when none exists", async () => {
    const iam = fakeIam({
      GetRoleCommand: noSuchEntity,
      CreateRoleCommand: () => ({ Role: { Arn: ROLE_ARN } }),
      PutRolePolicyCommand: () => ({}),
    });
    const arn = await ensureRuntimeExecutionRole(iam.iam, NAME, "us-west-2", PRIVATE_IMAGE);
    expect(arn).toBe(ROLE_ARN);
    const create = iam.sent.find((entry) => entry.name === "CreateRoleCommand")!.input;
    expect(create.RoleName).toBe(runtimeExecutionRoleName(NAME));
    expect(create.Tags).toEqual(CLI_TAGS);
    expect(JSON.parse(create.AssumeRolePolicyDocument).Statement[0].Principal).toEqual({
      Service: "bedrock-agentcore.amazonaws.com",
    });
    const put = iam.sent.find((entry) => entry.name === "PutRolePolicyCommand")!.input;
    expect(put.PolicyDocument).toBe(
      runtimeExecutionPolicy("us-west-2", ACCOUNT, NAME, PRIVATE_IMAGE),
    );
  });

  test("reuses the role it created for this runtime", async () => {
    const iam = fakeIam({
      GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN, Tags: CLI_TAGS } }),
      PutRolePolicyCommand: () => ({}),
    });
    await ensureRuntimeExecutionRole(iam.iam, NAME, "us-west-2", PRIVATE_IMAGE);
    expect(iam.names()).toEqual(["GetRoleCommand", "PutRolePolicyCommand"]);
  });

  test("refuses to take over a same-named role it did not create", async () => {
    const iam = fakeIam({ GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN, Tags: [] } }) });
    await expect(
      ensureRuntimeExecutionRole(iam.iam, NAME, "us-west-2", PRIVATE_IMAGE),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(iam.names()).toEqual(["GetRoleCommand"]);
  });
});

describe("refreshRuntimeExecutionRolePolicy", () => {
  test("rewrites the default role's policy for a new image", async () => {
    const iam = fakeIam({
      GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN, Tags: CLI_TAGS } }),
      PutRolePolicyCommand: () => ({}),
    });
    expect(
      await refreshRuntimeExecutionRolePolicy(iam.iam, NAME, ROLE_ARN, "us-west-2", PRIVATE_IMAGE),
    ).toBe(true);
  });

  test("leaves a caller-supplied role alone", async () => {
    const iam = fakeIam({});
    expect(
      await refreshRuntimeExecutionRolePolicy(
        iam.iam,
        NAME,
        `arn:aws:iam::${ACCOUNT}:role/Mine`,
        "us-west-2",
        PRIVATE_IMAGE,
      ),
    ).toBe(false);
    expect(iam.sent).toEqual([]);
  });
});

describe("deleteRuntimeExecutionRole", () => {
  test("deletes the inline policy and the role the CLI created for this runtime", async () => {
    const iam = fakeIam({
      GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN, Tags: CLI_TAGS } }),
      DeleteRolePolicyCommand: () => ({}),
      DeleteRoleCommand: () => ({}),
    });
    expect(await deleteRuntimeExecutionRole(iam.iam, NAME, ROLE_ARN)).toBe(true);
    expect(iam.names()).toEqual(["GetRoleCommand", "DeleteRolePolicyCommand", "DeleteRoleCommand"]);
  });

  test.each([
    ["untagged", []],
    [
      "created for another runtime",
      [{ ...CREATED_BY_TAG }, { Key: RUNTIME_TAG_KEY, Value: "other" }],
    ],
  ])("keeps a role that is %s", async (_label, tags) => {
    const iam = fakeIam({ GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN, Tags: tags } }) });
    expect(await deleteRuntimeExecutionRole(iam.iam, NAME, ROLE_ARN)).toBe(false);
    expect(iam.names()).toEqual(["GetRoleCommand"]);
  });
});
