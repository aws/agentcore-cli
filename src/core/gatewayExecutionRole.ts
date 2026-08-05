import { createHash } from "node:crypto";
import type { GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  type IAMClient,
  type Role,
} from "@aws-sdk/client-iam";
import { InputValidationError } from "../errors";
import {
  gatewayPolicyDocument,
  gatewayTargetPolicyDocument,
  type GatewayRoleConfiguration,
  type GatewayTargetPolicyContext,
  type GatewayTargetRoleConfiguration,
} from "./gatewayExecutionRolePolicy";

export type { GatewayTargetRoleConfiguration } from "./gatewayExecutionRolePolicy";

export const GATEWAY_EXECUTION_POLICY_NAME = "AgentCoreGatewayExecutionPolicy";
export const GATEWAY_ROLE_MANAGED_BY_TAG = {
  Key: "bedrock-agentcore:managed-by",
  Value: "agentcore-cli",
} as const;
export const GATEWAY_ROLE_RESOURCE_TYPE_TAG = {
  Key: "bedrock-agentcore:resource-type",
  Value: "gateway",
} as const;

export type GatewayExecutionRoleProvisioning = {
  roleArn: string;
  roleName: string;
  updatePolicy(gatewayArn?: string): Promise<void>;
  updateTrust(gatewayArn: string): Promise<void>;
};

export interface GatewayTargetExecutionRole {
  roleName: string;
  updatePolicy(configurations: GatewayTargetRoleConfiguration[]): Promise<void>;
}

export function gatewayExecutionRoleName(gatewayName: string, region: string): string {
  const suffix = createHash("sha256").update(`${region}:${gatewayName}`).digest("hex").slice(0, 12);
  return `AgentCoreGateway-${gatewayName.slice(0, 32)}-${suffix}`;
}

export async function ensureGatewayExecutionRole(
  iam: IAMClient,
  gatewayName: string,
  region: string,
  configuration: GatewayRoleConfiguration,
): Promise<GatewayExecutionRoleProvisioning> {
  const roleName = gatewayExecutionRoleName(gatewayName, region);
  const role = await getOrCreateOwnedRole(iam, roleName, gatewayName);
  const roleArn = requiredRoleArn(role, roleName);
  const arn = parseRoleArn(roleArn);
  const gatewayPattern = gatewayArnPattern(arn.partition, region, arn.accountId, gatewayName);

  await iam.send(
    new UpdateAssumeRolePolicyCommand({
      RoleName: roleName,
      PolicyDocument: trustPolicy(arn.accountId, gatewayPattern),
    }),
  );

  return {
    roleArn,
    roleName,
    updatePolicy: async (gatewayArn = gatewayPattern) =>
      await replaceGatewayExecutionPolicy(
        iam,
        roleName,
        gatewayPolicyDocument(configuration, gatewayArn),
      ),
    updateTrust: async (gatewayArn) => {
      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: trustPolicy(arn.accountId, gatewayArn),
        }),
      );
    },
  };
}

export async function retryWhileGatewayRoleChangesPropagate<T>(
  operation: () => Promise<T>,
  attempts = 8,
  delayMs = 2000,
  sleep: (delayMs: number) => Promise<void> = (delay) =>
    new Promise((resolve) => setTimeout(resolve, delay)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isGatewayRolePropagationError(error);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

export async function getManagedGatewayTargetExecutionRole(
  iam: IAMClient,
  gateway: GetGatewayResponse,
  region: string,
): Promise<GatewayTargetExecutionRole | undefined> {
  if (!gateway.roleArn || !gateway.name) return undefined;

  const parsedArn = parseRoleArn(gateway.roleArn);
  const expectedRoleName = gatewayExecutionRoleName(gateway.name, region);
  if (parsedArn.roleName !== expectedRoleName) return undefined;

  const response = await iam.send(new GetRoleCommand({ RoleName: parsedArn.roleName }));
  if (!isOwnedGatewayRole(response.Role)) return undefined;

  const gatewayId = gateway.gatewayId ?? gateway.gatewayArn?.split("/").at(-1);
  if (!gatewayId) {
    throw new Error("GetGateway response did not include the Gateway ID");
  }
  const context: GatewayTargetPolicyContext = {
    partition: parsedArn.partition,
    region,
    accountId: parsedArn.accountId,
    gatewayId,
    workloadIdentityArn: gateway.workloadIdentityDetails?.workloadIdentityArn,
  };
  const gatewayArn =
    gateway.gatewayArn ??
    `arn:${parsedArn.partition}:bedrock-agentcore:${region}:${parsedArn.accountId}:gateway/${gatewayId}`;

  return {
    roleName: parsedArn.roleName,
    updatePolicy: async (configurations) =>
      await replaceGatewayExecutionPolicy(
        iam,
        parsedArn.roleName,
        gatewayTargetPolicyDocument(gateway, gatewayArn, configurations, context),
      ),
  };
}

async function replaceGatewayExecutionPolicy(
  iam: IAMClient,
  roleName: string,
  policyDocument: string | undefined,
): Promise<void> {
  if (policyDocument) {
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: GATEWAY_EXECUTION_POLICY_NAME,
        PolicyDocument: policyDocument,
      }),
    );
    return;
  }

  try {
    await iam.send(
      new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: GATEWAY_EXECUTION_POLICY_NAME,
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
  }
}

async function getOrCreateOwnedRole(
  iam: IAMClient,
  roleName: string,
  gatewayName: string,
): Promise<Role> {
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    assertOwnedGatewayRole(existing.Role, roleName);
    return existing.Role!;
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
  }

  try {
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: bootstrapTrustPolicy(),
        Description: `Execution role for the AgentCore Gateway "${gatewayName}" created by the agentcore CLI`,
        Tags: [
          GATEWAY_ROLE_MANAGED_BY_TAG,
          GATEWAY_ROLE_RESOURCE_TYPE_TAG,
          { Key: "bedrock-agentcore:resource-name", Value: gatewayName },
        ],
      }),
    );
    return created.Role!;
  } catch (error) {
    if ((error as Error).name !== "EntityAlreadyExistsException") throw error;
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    assertOwnedGatewayRole(existing.Role, roleName);
    return existing.Role!;
  }
}

function assertOwnedGatewayRole(role: Role | undefined, roleName: string): void {
  if (isOwnedGatewayRole(role)) return;
  throw new InputValidationError(
    `IAM role "${roleName}" already exists but is not managed by the agentcore CLI; ` +
      "pass --role-arn with a customer-managed Gateway role",
  );
}

function isOwnedGatewayRole(role: Role | undefined): boolean {
  const tags = new Map(role?.Tags?.map(({ Key, Value }) => [Key, Value]));
  return (
    tags.get(GATEWAY_ROLE_MANAGED_BY_TAG.Key) === GATEWAY_ROLE_MANAGED_BY_TAG.Value &&
    tags.get(GATEWAY_ROLE_RESOURCE_TYPE_TAG.Key) === GATEWAY_ROLE_RESOURCE_TYPE_TAG.Value
  );
}

function requiredRoleArn(role: Role, roleName: string): string {
  if (!role.Arn) {
    throw new Error(`IAM did not return an ARN for role "${roleName}"`);
  }
  return role.Arn;
}

function bootstrapTrustPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "GatewayAssumeRoleBootstrap",
        Effect: "Deny",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

function trustPolicy(accountId: string, sourceArn: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "GatewayAssumeRolePolicy",
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": sourceArn },
        },
      },
    ],
  });
}

function isGatewayRolePropagationError(error: unknown): boolean {
  if ((error as Error).name !== "ValidationException") return false;
  const message = (error as Error).message ?? "";
  return [
    /\b(?:execution|gateway|iam)\s+role\b.*\b(?:assum|trust)\w*/i,
    /\b(?:assum|trust)\w*\b.*\brole\b/i,
    /\brole\b.*\b(?:lack|missing|permission|authoriz)\w*/i,
    /\b(?:permission|authoriz)\w*\b.*\brole\b/i,
  ].some((pattern) => pattern.test(message));
}

function parseRoleArn(arn: string): {
  partition: string;
  accountId: string;
  roleName: string;
} {
  const match = /^arn:([^:]+):iam::(\d{12}):role\/(.+)$/.exec(arn);
  const roleName = match?.[3]?.split("/").at(-1);
  if (!match || !roleName) {
    throw new InputValidationError(`Invalid IAM role ARN "${arn}"`);
  }
  return { partition: match[1]!, accountId: match[2]!, roleName };
}

function gatewayArnPattern(
  partition: string,
  region: string,
  accountId: string,
  gatewayName: string,
): string {
  return `arn:${partition}:bedrock-agentcore:${region}:${accountId}:gateway/${gatewayName}-*`;
}
