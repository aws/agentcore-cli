import { CreateRoleCommand, GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";

// Default harness execution role provisioning.
//
// CreateHarness requires an IAM role the AgentCore service can assume. When the
// caller doesn't bring one, HarnessClient provisions a per-harness default here:
// a role trusting bedrock-agentcore.amazonaws.com with an inline policy granting
// the baseline permissions a harness needs (model invocation, logs/metrics,
// built-in tools, managed memory, ...). The flow is idempotent — an existing
// role is reused and its inline policy refreshed — so repeated creates of the
// same harness name converge on one role.

export const HARNESS_EXECUTION_POLICY_NAME = "AgentCoreHarnessExecutionPolicy";

export type HarnessExecutionRole = {
  roleArn: string;
  roleName: string;
  policyDocument: string;
};

// executionRoleName derives the default role's name from the harness name. IAM
// role names cap at 64 characters; harness names are alphanumeric/underscore so
// no further sanitization is needed.
export function executionRoleName(harnessName: string): string {
  return `AgentCoreHarness-${harnessName}`.slice(0, 64);
}

// trustPolicy allows the AgentCore service principal to assume the role.
function trustPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

// executionPolicy is the default permissions document, parameterized on the
// caller's region/account and the harness name (scoping workload identities and
// managed memory to this harness).
function executionPolicy(region: string, accountId: string, harnessName: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BedrockModelInvocation",
        Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${region}:${accountId}:*`,
        ],
      },
      {
        Sid: "BedrockMantleInference",
        Effect: "Allow",
        Action: ["bedrock-mantle:CreateInference"],
        Resource: `arn:aws:bedrock-mantle:us-east-1:${accountId}:*`,
      },
      {
        Sid: "BedrockMantleCallWithBearerToken",
        Effect: "Allow",
        Action: ["bedrock-mantle:CallWithBearerToken"],
        Resource: "*",
      },
      {
        Sid: "EcrPublicTokenAccess",
        Effect: "Allow",
        Action: ["ecr-public:GetAuthorizationToken"],
        Resource: "*",
      },
      {
        Sid: "StsForEcrPublicPull",
        Effect: "Allow",
        Action: ["sts:GetServiceBearerToken"],
        Resource: "*",
      },
      {
        Sid: "XRayTracingAccess",
        Effect: "Allow",
        Action: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        Resource: "*",
      },
      {
        Sid: "CloudWatchLogsGroup",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        Resource: `arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/*`,
      },
      {
        Sid: "CloudWatchLogsDescribeGroups",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: `arn:aws:logs:${region}:${accountId}:log-group:*`,
      },
      {
        Sid: "CloudWatchLogsStream",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
      },
      {
        Sid: "CloudWatchMetricsPublish",
        Effect: "Allow",
        Resource: "*",
        Action: "cloudwatch:PutMetricData",
        Condition: {
          StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
        },
      },
      {
        Sid: "AgentCoreWorkloadIdentity",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        ],
        Resource: [
          `arn:aws:bedrock-agentcore:${region}:${accountId}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${accountId}:workload-identity-directory/default/workload-identity/${harnessName}-*`,
        ],
      },
      {
        Sid: "AgentCoreBrowserDefault",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:StartBrowserSession",
          "bedrock-agentcore:StopBrowserSession",
          "bedrock-agentcore:GetBrowserSession",
          "bedrock-agentcore:ListBrowserSessions",
          "bedrock-agentcore:UpdateBrowserStream",
          "bedrock-agentcore:ConnectBrowserAutomationStream",
          "bedrock-agentcore:ConnectBrowserLiveViewStream",
        ],
        Resource: `arn:aws:bedrock-agentcore:${region}:aws:browser/*`,
      },
      {
        Sid: "AgentCoreCodeInterpreterDefault",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:StopCodeInterpreterSession",
          "bedrock-agentcore:GetCodeInterpreterSession",
          "bedrock-agentcore:ListCodeInterpreterSessions",
          "bedrock-agentcore:InvokeCodeInterpreter",
        ],
        Resource: `arn:aws:bedrock-agentcore:${region}:aws:code-interpreter/*`,
      },
      {
        Sid: "EFSClientAccess",
        Effect: "Allow",
        Action: ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"],
        Resource: `arn:aws:elasticfilesystem:${region}:${accountId}:file-system/*`,
        Condition: {
          ArnLike: {
            "elasticfilesystem:AccessPointArn": `arn:aws:elasticfilesystem:${region}:${accountId}:access-point/*`,
          },
        },
      },
      {
        Sid: "EFSDescribe",
        Effect: "Allow",
        Action: [
          "elasticfilesystem:DescribeAccessPoints",
          "elasticfilesystem:DescribeMountTargets",
        ],
        Resource: [
          `arn:aws:elasticfilesystem:${region}:${accountId}:file-system/*`,
          `arn:aws:elasticfilesystem:${region}:${accountId}:access-point/*`,
        ],
      },
      {
        Sid: "S3FilesClientAccess",
        Effect: "Allow",
        Action: ["s3files:ClientMount", "s3files:ClientWrite", "s3files:ClientRootAccess"],
        Resource: `arn:aws:s3files:${region}:${accountId}:file-system/*`,
        Condition: {
          ArnLike: {
            "s3files:AccessPointArn": `arn:aws:s3files:${region}:${accountId}:file-system/*/access-point/*`,
          },
        },
      },
      {
        Sid: "S3FilesDescribe",
        Effect: "Allow",
        Action: ["s3files:GetAccessPoint", "s3files:ListMountTargets"],
        Resource: [
          `arn:aws:s3files:${region}:${accountId}:file-system/*`,
          `arn:aws:s3files:${region}:${accountId}:file-system/*/access-point/*`,
        ],
      },
      {
        Sid: "AgentCoreMemory",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:DeleteEvent",
          "bedrock-agentcore:GetEvent",
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:RetrieveMemoryRecords",
        ],
        Resource: `arn:aws:bedrock-agentcore:${region}:${accountId}:memory/harness_*`,
      },
      {
        Sid: "AgentCoreGatewayAccess",
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeGateway"],
        Resource: [`arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/*`],
      },
    ],
  });
}

// accountIdFromRoleArn extracts the account id from a role ARN
// (arn:aws:iam::<account>:role/<name>), which saves an STS lookup: the account
// only becomes relevant once we hold the role's ARN anyway.
function accountIdFromRoleArn(arn: string): string {
  const accountId = arn.split(":")[4];
  if (!accountId) {
    throw new Error(`Cannot extract an account id from role ARN "${arn}"`);
  }
  return accountId;
}

// ensureDefaultExecutionRole creates or reuses the role and returns the complete
// policy document that HarnessClient applies transactionally around creation.
export async function ensureDefaultExecutionRole(
  iam: IAMClient,
  harnessName: string,
  region: string,
): Promise<HarnessExecutionRole> {
  const roleName = executionRoleName(harnessName);

  let roleArn: string;
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    roleArn = existing.Role!.Arn!;
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy(),
        Description: `Default execution role for the AgentCore harness "${harnessName}" (created by the agentcore CLI)`,
      }),
    );
    roleArn = created.Role!.Arn!;
  }

  return {
    roleArn,
    roleName,
    policyDocument: executionPolicy(region, accountIdFromRoleArn(roleArn), harnessName),
  };
}
