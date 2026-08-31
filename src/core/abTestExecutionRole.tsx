import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { createHash } from "node:crypto";

const AB_TEST_POLICY_NAME = "ABTestExecutionPolicy";

export function abTestExecutionRoleName(testName: string): string {
  const hash = createHash("sha256").update(`ab-test:${testName}`).digest("hex").slice(0, 8);
  const base = `AgentCoreABTest-${testName}`;
  return `${base.slice(0, 55)}-${hash}`;
}

export function roleNameFromArn(roleArn: string): string {
  const parts = roleArn.split("/");
  return parts[parts.length - 1] ?? roleArn;
}

export function accountIdFromArn(arn: string): string {
  const accountId = arn.split(":")[4];
  if (!accountId) throw new Error(`could not extract account id from ARN: ${arn}`);
  return accountId;
}

function trustPolicy(accountId: string, region: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock-agentcore:${region}:${accountId}:ab-test/*`,
          },
        },
      },
    ],
  });
}

function executionPolicy(accountId: string, region: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AgentCoreResources",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:GetGateway",
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
          "bedrock-agentcore:CreateGatewayRule",
          "bedrock-agentcore:UpdateGatewayRule",
          "bedrock-agentcore:GetGatewayRule",
          "bedrock-agentcore:DeleteGatewayRule",
          "bedrock-agentcore:ListGatewayRules",
          "bedrock-agentcore:GetOnlineEvaluationConfig",
          "bedrock-agentcore:GetEvaluator",
          "bedrock-agentcore:GetConfigurationBundle",
          "bedrock-agentcore:GetConfigurationBundleVersion",
          "bedrock-agentcore:ListConfigurationBundleVersions",
        ],
        Resource: `arn:aws:bedrock-agentcore:${region}:${accountId}:*`,
        Condition: { StringEquals: { "aws:ResourceAccount": accountId } },
      },
      {
        Sid: "CloudWatchLogsDescribe",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: "*",
      },
      {
        Sid: "CloudWatchLogs",
        Effect: "Allow",
        Action: [
          "logs:DescribeIndexPolicies",
          "logs:PutIndexPolicy",
          "logs:StartQuery",
          "logs:GetQueryResults",
          "logs:StopQuery",
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
        ],
        Resource: [
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/evaluations/*`,
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:aws:logs:${region}:${accountId}:log-group:aws/spans`,
          `arn:aws:logs:${region}:${accountId}:log-group:aws/spans:*`,
        ],
      },
    ],
  });
}

export async function provisionAbTestRole(
  iam: IAMClient,
  testName: string,
  gatewayArn: string,
  region: string,
): Promise<{ roleArn: string; created: boolean }> {
  const accountId = accountIdFromArn(gatewayArn);
  const roleName = abTestExecutionRoleName(testName);

  let roleArn: string;
  let created = false;
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    roleArn = existing.Role!.Arn!;
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
    const result = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy(accountId, region),
        Description: `Execution role for AgentCore A/B test "${testName}" (created by agentcore CLI)`,
      }),
    );
    roleArn = result.Role!.Arn!;
    created = true;
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: AB_TEST_POLICY_NAME,
      PolicyDocument: executionPolicy(accountId, region),
    }),
  );

  return { roleArn, created };
}

export async function deleteAbTestRole(iam: IAMClient, roleArn: string): Promise<void> {
  const roleName = roleNameFromArn(roleArn);
  try {
    await iam.send(
      new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: AB_TEST_POLICY_NAME }),
    );
  } catch {
    void 0;
  }
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch {
    void 0;
  }
}
