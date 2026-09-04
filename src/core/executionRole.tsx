import {
  CreateRoleCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type {
  ExecutionRoleProvisioner,
  ExecutionRoleState,
} from "./project/backends/imperative/types";

// Default harness execution role provisioning.
//
// CreateHarness requires an IAM role the AgentCore service can assume. When the
// caller doesn't bring one, HarnessClient provisions a per-harness default here:
// a role trusting bedrock-agentcore.amazonaws.com with an inline policy granting
// the baseline permissions a harness needs (model invocation, logs/metrics,
// built-in tools, managed memory, ...). The flow is idempotent — an existing
// role is reused and its inline policy refreshed — so repeated creates of the
// same harness name converge on one role.

export const EXECUTION_POLICY_NAME = "AgentCoreHarnessExecutionPolicy";

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

/**
 * What a harness's configuration adds to the baseline policy. `harness create`
 * passes nothing and gets the document it always did; the imperative deploy
 * passes what it can read off the spec.
 */
export type ExecutionPolicyOptions = {
  /**
   * The harness owns a service-managed memory. Created through the API it is
   * named after the harness (`<harnessName>-<id>`), which the baseline
   * `memory/harness_*` grant does not cover, so the grant widens to it.
   */
  managedMemory?: boolean;
  /**
   * The bucket and key prefix the harness's skills/ directory was synced to.
   * Both or neither: the grant is scoped to exactly that prefix so one
   * harness's role cannot read another project's skills.
   */
  skillsBucket?: string;
  skillsPrefix?: string;
};

/**
 * The default permissions document, parameterized on the caller's
 * region/account and the harness name (scoping workload identities and managed
 * memory to this harness). Returned as an object so a caller can compare it
 * with what IAM holds; `executionPolicy` is its serialized form.
 */
export function desiredExecutionPolicy(
  region: string,
  accountId: string,
  harnessName: string,
  options: ExecutionPolicyOptions = {},
): Record<string, unknown> {
  return {
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
        Resource: options.managedMemory
          ? [
              `arn:aws:bedrock-agentcore:${region}:${accountId}:memory/harness_*`,
              `arn:aws:bedrock-agentcore:${region}:${accountId}:memory/${harnessName}-*`,
            ]
          : `arn:aws:bedrock-agentcore:${region}:${accountId}:memory/harness_*`,
      },
      {
        Sid: "AgentCoreGatewayAccess",
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeGateway"],
        Resource: [`arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/*`],
      },
      ...(options.skillsBucket && options.skillsPrefix
        ? [
            {
              Sid: "AgentCoreSkillsRead",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: `arn:aws:s3:::${options.skillsBucket}/${options.skillsPrefix}*`,
            },
            {
              Sid: "AgentCoreSkillsList",
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: `arn:aws:s3:::${options.skillsBucket}`,
              Condition: { StringLike: { "s3:prefix": [`${options.skillsPrefix}*`] } },
            },
          ]
        : []),
    ],
  };
}

function executionPolicy(
  region: string,
  accountId: string,
  harnessName: string,
  options?: ExecutionPolicyOptions,
): string {
  return JSON.stringify(desiredExecutionPolicy(region, accountId, harnessName, options));
}

// accountIdFromRoleArn extracts the account id from a role ARN
// (arn:aws:iam::<account>:role/<name>), which saves an STS lookup: the account
// only becomes relevant once we hold the role's ARN anyway.
export function accountIdFromRoleArn(arn: string): string {
  const accountId = arn.split(":")[4];
  if (!accountId) {
    throw new Error(`Cannot extract an account id from role ARN "${arn}"`);
  }
  return accountId;
}

// ensureDefaultExecutionRole returns the ARN of the default execution role for
// `harnessName`, creating the role if it doesn't exist and (re)attaching the
// default inline policy either way.
export async function ensureDefaultExecutionRole(
  iam: IAMClient,
  harnessName: string,
  region: string,
  options?: ExecutionPolicyOptions,
): Promise<string> {
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

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: EXECUTION_POLICY_NAME,
      PolicyDocument: executionPolicy(region, accountIdFromRoleArn(roleArn), harnessName, options),
    }),
  );

  return roleArn;
}

/**
 * The IAM-backed {@link ExecutionRoleProvisioner} an imperative deploy uses:
 * `describe` is the read side (GetRole + GetRolePolicy) its status check
 * compares against the desired document, `ensure` is the write side, which is
 * `ensureDefaultExecutionRole` itself.
 */
export function createIamExecutionRoleProvisioner(
  iamFor: (region: string) => IAMClient,
): ExecutionRoleProvisioner {
  return {
    async describe(harnessName, region): Promise<ExecutionRoleState | undefined> {
      const iam = iamFor(region);
      const roleName = executionRoleName(harnessName);
      let roleArn: string;
      try {
        const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
        roleArn = existing.Role!.Arn!;
      } catch (error) {
        if ((error as Error).name === "NoSuchEntityException") return undefined;
        throw error;
      }
      try {
        const policy = await iam.send(
          new GetRolePolicyCommand({ RoleName: roleName, PolicyName: EXECUTION_POLICY_NAME }),
        );
        // IAM returns inline policy documents URL-encoded.
        const document = policy.PolicyDocument
          ? decodeURIComponent(policy.PolicyDocument)
          : undefined;
        return { roleArn, policyDocument: document };
      } catch (error) {
        if ((error as Error).name === "NoSuchEntityException") return { roleArn };
        throw error;
      }
    },
    ensure(harnessName, region, options) {
      return ensureDefaultExecutionRole(iamFor(region), harnessName, region, options);
    },
  };
}
