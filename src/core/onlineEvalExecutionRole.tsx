import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";

// Default online-evaluation execution role provisioning, mirroring
// core/executionRole.tsx's pattern for harnesses: CreateOnlineEvaluationConfig
// requires an IAM role the service assumes to read the target CloudWatch log
// group, invoke Bedrock models for LLM-as-a-Judge evaluators, and write
// evaluation results back to CloudWatch. When the caller doesn't bring one,
// OnlineEvalClient provisions a per-config default here, scoped to the log
// group(s) being sampled. Idempotent: an existing role is reused and its
// inline policy refreshed.

const POLICY_NAME = "AgentCoreOnlineEvalExecutionPolicy";

// executionRoleName derives the default role's name from the online eval config
// name. IAM role names cap at 64 characters.
export function onlineEvalExecutionRoleName(configName: string): string {
  return `AgentCoreOnlineEval-${configName}`.slice(0, 64);
}

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

// runtimeLogGroupPrefix strips the trailing `-<endpoint>` qualifier from an
// AgentCore runtime log group name, yielding the runtime-level prefix the
// service expects the execution role to be scoped to. A log group that does not
// follow the runtime naming convention (e.g. a caller-supplied custom group) is
// returned unchanged.
function runtimeLogGroupPrefix(logGroupName: string): string {
  const match = logGroupName.match(/^(\/aws\/bedrock-agentcore\/runtimes\/.+)-[^-]+$/);
  return match?.[1] ?? logGroupName;
}

// executionPolicy grants the permissions CreateOnlineEvaluationConfig validates
// at creation time: Logs Insights query access over the sampled log groups plus
// the `aws/spans` group that carries the actual trace spans, Bedrock model
// invocation for LLM-as-a-Judge evaluators, Lambda invocation for code-based
// ones, and permission to write results back to CloudWatch. Modeled on the
// policy the CDK-deployed online evaluations use, since the service rejects a
// role that cannot query the log groups it was pointed at.
function executionPolicy(region: string, accountId: string, logGroupNames: string[]): string {
  const logs = `arn:aws:logs:${region}:${accountId}:log-group`;
  const spansArn = `${logs}:aws/spans`;
  // Scope to the runtime prefix rather than the exact endpoint log group: the
  // service validates query access at the runtime level (all of a runtime's
  // endpoints share the `...-<runtimeId>-<endpoint>` naming), and a policy
  // pinned to one endpoint is rejected as insufficient.
  const sampledArns = logGroupNames.map((name) => `${logs}:${runtimeLogGroupPrefix(name)}*`);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DiscoverLogGroups",
        Effect: "Allow",
        Action: [
          "cloudwatch:GenerateQuery",
          "cloudwatch:GenerateQueryResultsSummary",
          "logs:DescribeLogGroups",
        ],
        Resource: "*",
      },
      {
        // Spans live in `aws/spans`; the runtime's own log group carries the
        // session logs. Both are queried when sampling sessions.
        Sid: "QuerySampledTraces",
        Effect: "Allow",
        Action: [
          "logs:DescribeLogStreams",
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:GetQueryResults",
          "logs:StartQuery",
        ],
        Resource: [`${spansArn}*`, ...sampledArns],
      },
      {
        Sid: "WriteEvaluationResults",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
        ],
        Resource: `${logs}:/aws/bedrock-agentcore/evaluations/*`,
      },
      {
        Sid: "IndexSpans",
        Effect: "Allow",
        Action: ["logs:DescribeIndexPolicies", "logs:PutIndexPolicy"],
        Resource: spansArn,
      },
      {
        Sid: "BedrockModelInvocation",
        Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      },
      {
        // Code-based evaluators are Lambda-backed, so the role that runs an
        // online evaluation must be able to invoke them.
        Sid: "InvokeCodeBasedEvaluators",
        Effect: "Allow",
        Action: ["lambda:GetFunction", "lambda:InvokeFunction"],
        Resource: `arn:aws:lambda:${region}:${accountId}:function:*`,
      },
    ],
  });
}

function accountIdFromRoleArn(arn: string): string {
  const accountId = arn.split(":")[4];
  if (!accountId) {
    throw new Error(`Cannot extract an account id from role ARN "${arn}"`);
  }
  return accountId;
}

// ensureDefaultOnlineEvalExecutionRole returns the ARN of the default execution
// role for `configName`, creating the role if it doesn't exist and
// (re)attaching a policy scoped to `logGroupNames` either way.
export async function ensureDefaultOnlineEvalExecutionRole(
  iam: IAMClient,
  configName: string,
  region: string,
  logGroupNames: string[],
): Promise<string> {
  const roleName = onlineEvalExecutionRoleName(configName);

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
        Description: `Default execution role for the AgentCore online evaluation config "${configName}" (created by the agentcore CLI)`,
      }),
    );
    roleArn = created.Role!.Arn!;
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: POLICY_NAME,
      PolicyDocument: executionPolicy(region, accountIdFromRoleArn(roleArn), logGroupNames),
    }),
  );

  return roleArn;
}
