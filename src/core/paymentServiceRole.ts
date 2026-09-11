import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { createHash } from "node:crypto";
import { InputValidationError } from "../errors";
import { parseArn } from "./arn";

// Default payment service role provisioning.
//
// CreatePaymentManager requires an IAM role the AgentCore Payments service assumes
// at runtime to mint workload tokens, read the connector's credential provider,
// and fetch payment tokens. When the caller doesn't bring one, PaymentClient
// provisions a per-manager default here, mirroring core/executionRole.ts for
// harnesses: a role trusting bedrock-agentcore.amazonaws.com with one inline
// policy carrying the actions the AgentCore L3 CDK construct grants its
// ResourceRetrievalRole. Only CLI-owned roles for the same manager and region
// are reused and have their inline policy refreshed.

const POLICY_NAME = "AgentCorePaymentsServicePolicy";

const ROLE_NAME_PREFIX = "AgentCorePayments-";
const ROLE_NAME_MAX = 64;
const NAME_HASH_LENGTH = 12;

// IAM names are account-global; the policy is regional. Hash the full identity
// before truncation so long manager names cannot collapse onto the same role.
export function paymentServiceRoleName(managerName: string, region: string): string {
  const full = `${ROLE_NAME_PREFIX}${region}-${managerName}`;
  if (full.length <= ROLE_NAME_MAX) return full;

  const hash = createHash("sha256").update(full).digest("hex").slice(0, NAME_HASH_LENGTH);
  return `${full.slice(0, ROLE_NAME_MAX - NAME_HASH_LENGTH - 1)}-${hash}`;
}

// trustPolicy allows the AgentCore service principal to assume the role.
export function trustPolicy(): string {
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

// servicePolicy is the permissions document, parameterized on the caller's
// region and account so the secret grant stays inside them. Every
// AgentCore-managed credential secret is stored under the
// `bedrock-agentcore-identity!` prefix, so granting the prefix covers each
// connector's credentials up front and adding a connector never has to mutate
// the role.
export function servicePolicy(region: string, accountId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AgentCoreIdentityAndTokens",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:RetrieveToken",
          "bedrock-agentcore:GetWorkloadIdentity",
          "bedrock-agentcore:CreateWorkloadIdentity",
          "bedrock-agentcore:GetPaymentCredentialProvider",
          "bedrock-agentcore:TagResource",
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetResourcePaymentToken",
        ],
        Resource: "*",
      },
      {
        Sid: "IdentityManagedSecrets",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:bedrock-agentcore-identity!*`,
      },
      {
        Sid: "StsSetContext",
        Effect: "Allow",
        Action: ["sts:SetContext"],
        Resource: "*",
      },
    ],
  });
}

// accountIdFromRoleArn extracts the account id from a role ARN
// (arn:aws:iam::<account>:role/<name>), which saves an STS lookup.
function accountIdFromRoleArn(arn: string): string {
  const accountId = parseArn(arn)?.account;
  if (!accountId) {
    throw new Error(`Cannot extract an account id from role ARN "${arn}"`);
  }
  return accountId;
}

// ensurePaymentServiceRole returns the ARN of the default service role for
// `managerName`, creating the role if it doesn't exist and (re)attaching the
// inline policy either way.
export async function ensurePaymentServiceRole(
  iam: IAMClient,
  managerName: string,
  region: string,
): Promise<string> {
  const roleName = paymentServiceRoleName(managerName, region);
  const tags = [
    { Key: "agentcore:managed-by", Value: "agentcore-cli" },
    { Key: "agentcore:payment-manager", Value: managerName },
    { Key: "agentcore:region", Value: region },
  ];

  let roleArn: string;
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    if (
      !tags.every(({ Key, Value }) =>
        existing.Role?.Tags?.some((tag) => tag.Key === Key && tag.Value === Value),
      )
    ) {
      throw new InputValidationError(
        `IAM role "${roleName}" already exists but is not owned by this CLI payment manager in ${region}. ` +
          "Use --role-arn to supply a role explicitly, or choose a different manager name; the existing role was not changed.",
      );
    }
    roleArn = existing.Role!.Arn!;
  } catch (error) {
    if ((error as Error).name !== "NoSuchEntityException") throw error;
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy(),
        Tags: tags,
        Description: `Default service role for the AgentCore payment manager "${managerName}" (created by the agentcore CLI)`,
      }),
    );
    roleArn = created.Role!.Arn!;
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: POLICY_NAME,
      PolicyDocument: servicePolicy(region, accountIdFromRoleArn(roleArn)),
    }),
  );

  return roleArn;
}
