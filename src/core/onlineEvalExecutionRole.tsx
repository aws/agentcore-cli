import {
  CreateRoleCommand,
  DeleteRolePolicyCommand,
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
// group(s) being sampled. Idempotent: an existing role is reused.
//
// Each scope is stored as its own inline policy, named after a fingerprint of the
// scope, so granting a new scope never overwrites the policy backing the current
// one. IAM unions Allows across a role's inline policies, which lets an update
// grant the new scope before changing the config and drop the old scope only once
// the change has landed.

const POLICY_PREFIX = "AgentCoreOnlineEvalExecutionPolicy";

const ROLE_NAME_PREFIX = "AgentCoreOnlineEval-";
const ROLE_NAME_MAX = 64;
const NAME_HASH_LENGTH = 8;

// onlineEvalExecutionRoleName derives the default role's name from the online eval
// config name. IAM caps role names at 64 characters, which leaves only 44 for the
// config name — while config names run to 100 — so a name that would overflow is
// truncated and given a hash suffix. Truncating alone would let two configs share
// one role, and because provisioning is idempotent by name the second create would
// silently re-scope the first's policy to a different runtime.
export function onlineEvalExecutionRoleName(configName: string): string {
  const full = `${ROLE_NAME_PREFIX}${configName}`;
  if (full.length <= ROLE_NAME_MAX) return full;

  const hash = Bun.hash(configName)
    .toString(16)
    .padStart(NAME_HASH_LENGTH, "0")
    .slice(-NAME_HASH_LENGTH);
  const room = ROLE_NAME_MAX - ROLE_NAME_PREFIX.length - NAME_HASH_LENGTH - 1;
  return `${ROLE_NAME_PREFIX}${configName.slice(0, room)}-${hash}`;
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
// at creation time. Exported for assertion: the policy body is not observable
// through the recorded IAM fixtures, whose responses are empty.
//
// at creation time: Logs Insights query access over the sampled log groups plus
// the `aws/spans` group that carries the actual trace spans, Bedrock model
// invocation for LLM-as-a-Judge evaluators, Lambda invocation for code-based
// ones, and permission to write results back to CloudWatch. Modeled on the
// policy the CDK-deployed online evaluations use, since the service rejects a
// role that cannot query the log groups it was pointed at.
export function executionPolicy(
  region: string,
  accountId: string,
  logGroupNames: string[],
  kmsKeyArns: string[],
): string {
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
      // Evaluators encrypted with a customer managed key need kms:Decrypt on that
      // key, which the service validates when the config is created. Scoped to the
      // referenced keys, and omitted when no evaluator is encrypted.
      ...(kmsKeyArns.length > 0
        ? [
            {
              Sid: "DecryptEvaluatorKeys",
              Effect: "Allow",
              Action: ["kms:Decrypt", "kms:DescribeKey"],
              Resource: kmsKeyArns,
            },
          ]
        : []),
    ],
  });
}

export function accountIdFromRoleArn(arn: string): string {
  const accountId = arn.split(":")[4];
  if (!accountId) {
    throw new Error(`Cannot extract an account id from role ARN "${arn}"`);
  }
  return accountId;
}

// scopePolicyName derives the inline-policy name from a fingerprint of the whole
// rendered policy document. Keying the name on the policy's exact contents means
// any change to what the policy grants yields a new name, so writing one scope's
// policy can never clobber another's — a superseded scope stays intact until it
// is explicitly revoked.
export function scopePolicyName(policyDocument: string): string {
  const fingerprint = Bun.hash(policyDocument)
    .toString(16)
    .padStart(NAME_HASH_LENGTH, "0")
    .slice(-NAME_HASH_LENGTH);
  return `${POLICY_PREFIX}-${fingerprint}`;
}

// grantOnlineEvalScope creates the execution role for `configName` if it does not
// exist and attaches the inline policy for this scope, returning the role ARN and
// the policy name written. The caller revokes the superseded scope once whatever
// change prompted the new one has succeeded.
export async function grantOnlineEvalScope(
  iam: IAMClient,
  configName: string,
  region: string,
  logGroupNames: string[],
  kmsKeyArns: string[] = [],
): Promise<{ roleArn: string; policyName: string }> {
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

  const policyDocument = executionPolicy(
    region,
    accountIdFromRoleArn(roleArn),
    logGroupNames,
    kmsKeyArns,
  );
  const policyName = scopePolicyName(policyDocument);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: policyDocument,
    }),
  );

  return { roleArn, policyName };
}

// revokeOnlineEvalScope detaches a scope's inline policy, dropping the access it
// granted. A scope that is already absent is treated as revoked.
export async function revokeOnlineEvalScope(
  iam: IAMClient,
  configName: string,
  policyName: string,
): Promise<void> {
  try {
    await iam.send(
      new DeleteRolePolicyCommand({
        RoleName: onlineEvalExecutionRoleName(configName),
        PolicyName: policyName,
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
  }
}
