import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
  type Tag,
} from "@aws-sdk/client-iam";
import { partition } from "@aws-sdk/util-endpoints";
import { InputValidationError } from "../errors";
import { parseContainerUri } from "../projectSchemas/container";
import { parseArn } from "./arn";

// Default execution role for `agentcore runtime create`.
//
// CreateAgentRuntime requires a role the AgentCore service can assume. When the
// caller doesn't bring one, RuntimeClient provisions a per-runtime role that can
// do exactly what a container Runtime needs to start and log: pull its image
// from the one ECR repository named by --container-uri, and write to its own
// CloudWatch log group. Anything the agent code itself calls (models, memory,
// gateways, ...) needs a role the caller supplies.
//
// The role is tagged so `agentcore runtime delete --delete-execution-role` can
// tell a role this CLI created for this runtime from one it must not touch.

const POLICY_NAME = "AgentCoreRuntimeExecutionPolicy";
export const CREATED_BY_TAG = { Key: "agentcore:created-by", Value: "agentcore-cli" } as const;
export const RUNTIME_TAG_KEY = "agentcore:runtime";

/** IAM role names cap at 64 characters; runtime names are alphanumeric/underscore. */
export function runtimeExecutionRoleName(runtimeName: string): string {
  return `AgentCoreRuntime-${runtimeName}`.slice(0, 64);
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

/**
 * The default role's permissions: ECR pull on exactly the image's repository
 * (public.ecr.aws images need none) and CloudWatch Logs for this runtime's log
 * groups, whose names start with the runtime ID and so with its name.
 */
export function runtimeExecutionPolicy(
  region: string,
  accountId: string,
  runtimeName: string,
  containerUri: string,
): string {
  const image = parseContainerUri(containerUri);
  if (!image) throw new InputValidationError(`Invalid container image URI: ${containerUri}`);
  const arnPartition = partition(region).name;
  const logGroup = `arn:${arnPartition}:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`;
  const ecr =
    image.registry === "private"
      ? [
          {
            Sid: "EcrImagePull",
            Effect: "Allow",
            Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
            Resource: `arn:${partition(image.region).name}:ecr:${image.region}:${image.account}:repository/${image.repository}`,
          },
          {
            // GetAuthorizationToken has no resource-level scoping.
            Sid: "EcrAuthorizationToken",
            Effect: "Allow",
            Action: ["ecr:GetAuthorizationToken"],
            Resource: "*",
          },
        ]
      : [];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      ...ecr,
      {
        Sid: "CloudWatchLogsGroup",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        Resource: logGroup,
      },
      {
        Sid: "CloudWatchLogsStream",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `${logGroup}:log-stream:*`,
      },
    ],
  });
}

function createdForRuntime(tags: Tag[] | undefined, runtimeName: string): boolean {
  const value = (key: string) => tags?.find((tag) => tag.Key === key)?.Value;
  return (
    value(CREATED_BY_TAG.Key) === CREATED_BY_TAG.Value && value(RUNTIME_TAG_KEY) === runtimeName
  );
}

/**
 * Returns the ARN of the default execution role for `runtimeName`, creating it
 * when absent and (re)writing its inline policy for `containerUri` either way.
 * An existing role of that name that this CLI did not create for this runtime is
 * left alone: the caller must pass --execution-role-arn instead.
 */
export async function ensureRuntimeExecutionRole(
  iam: IAMClient,
  runtimeName: string,
  region: string,
  containerUri: string,
): Promise<string> {
  const roleName = runtimeExecutionRoleName(runtimeName);
  let roleArn: string;
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    if (!createdForRuntime(existing.Role?.Tags, runtimeName)) {
      throw new InputValidationError(
        `IAM role ${roleName} already exists and was not created by the agentcore CLI for ` +
          `runtime ${runtimeName}. Pass --execution-role-arn to use an existing role.`,
      );
    }
    roleArn = existing.Role!.Arn!;
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy(),
        Description: `Default execution role for the AgentCore Runtime "${runtimeName}" (created by the agentcore CLI)`,
        Tags: [{ ...CREATED_BY_TAG }, { Key: RUNTIME_TAG_KEY, Value: runtimeName }],
      }),
    );
    roleArn = created.Role!.Arn!;
  }
  const accountId = parseArn(roleArn)?.account;
  if (!accountId) throw new Error(`Cannot extract an account id from role ARN "${roleArn}"`);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: POLICY_NAME,
      PolicyDocument: runtimeExecutionPolicy(region, accountId, runtimeName, containerUri),
    }),
  );
  return roleArn;
}

/**
 * Deletes `roleArn` when it is the default role this CLI created for
 * `runtimeName` (tagged so). Returns false, deleting nothing, for any other role.
 */
export async function deleteRuntimeExecutionRole(
  iam: IAMClient,
  runtimeName: string,
  roleArn: string,
): Promise<boolean> {
  const roleName = parseArn(roleArn)?.resource.split("/").pop();
  if (!roleName) return false;
  const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  if (!createdForRuntime(role.Role?.Tags, runtimeName)) return false;
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: POLICY_NAME }));
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
  }
  await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  return true;
}

/**
 * Rewrites the default role's inline policy for a new image, when `roleArn` is
 * the default role this CLI created for `runtimeName`. Any other role is the
 * caller's to manage and is left alone; returns whether the policy was updated.
 */
export async function refreshRuntimeExecutionRolePolicy(
  iam: IAMClient,
  runtimeName: string,
  roleArn: string,
  region: string,
  containerUri: string,
): Promise<boolean> {
  const parsed = parseArn(roleArn);
  const roleName = parsed?.resource.split("/").pop();
  if (!parsed || roleName !== runtimeExecutionRoleName(runtimeName)) return false;
  const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  if (!createdForRuntime(role.Role?.Tags, runtimeName)) return false;
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: POLICY_NAME,
      PolicyDocument: runtimeExecutionPolicy(region, parsed.account, runtimeName, containerUri),
    }),
  );
  return true;
}
