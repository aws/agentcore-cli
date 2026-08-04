import { createHash } from "node:crypto";
import {
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";

const POLICY_HASH_LENGTH = 32;
const MAX_POLICY_NAME_LENGTH = 128;

export type InlinePolicySwapOptions = {
  roleName: string;
  policyNamePrefix: string;
  policyDocument: string;
};

export function candidateInlinePolicyName(
  policyNamePrefix: string,
  policyDocument: string,
): string {
  const suffix = createHash("sha256")
    .update(policyDocument)
    .digest("hex")
    .slice(0, POLICY_HASH_LENGTH);
  const name = `${policyNamePrefix}-${suffix}`;
  if (name.length > MAX_POLICY_NAME_LENGTH) {
    throw new Error(
      `IAM policy name prefix must be at most ${MAX_POLICY_NAME_LENGTH - POLICY_HASH_LENGTH - 1} characters`,
    );
  }
  return name;
}

export async function swapInlinePolicyForOperation<T>(
  iam: IAMClient,
  options: InlinePolicySwapOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const existingPolicyNames = (await listInlinePolicyNames(iam, options.roleName)).filter((name) =>
    isPolicyFamilyMember(name, options.policyNamePrefix),
  );
  const candidateName = candidateInlinePolicyName(options.policyNamePrefix, options.policyDocument);
  const candidateExisted = existingPolicyNames.includes(candidateName);

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: options.roleName,
      PolicyName: candidateName,
      PolicyDocument: options.policyDocument,
    }),
  );

  let result: T;
  try {
    result = await operation();
  } catch (operationError) {
    if (!candidateExisted) {
      try {
        await deleteInlinePolicies(iam, options.roleName, [candidateName]);
      } catch (rollbackError) {
        throw new AggregateError(
          [operationError, rollbackError],
          "Operation failed and its candidate IAM policy could not be removed",
        );
      }
    }
    throw operationError;
  }

  const previousPolicyNames = existingPolicyNames.filter((name) => name !== candidateName);
  try {
    await deleteInlinePolicies(iam, options.roleName, previousPolicyNames);
  } catch (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      "Operation succeeded but previous IAM policies could not be removed",
    );
  }
  return result;
}

async function listInlinePolicyNames(iam: IAMClient, roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const response = await iam.send(
      new ListRolePoliciesCommand({
        RoleName: roleName,
        ...(marker ? { Marker: marker } : {}),
      }),
    );
    names.push(...(response.PolicyNames ?? []));
    marker = response.IsTruncated ? response.Marker : undefined;
  } while (marker);
  return names;
}

function isPolicyFamilyMember(name: string, prefix: string): boolean {
  if (name === prefix) return true;
  const suffix = name.slice(prefix.length + 1);
  return name.startsWith(`${prefix}-`) && /^[0-9a-f]{32}$/.test(suffix);
}

async function deleteInlinePolicies(
  iam: IAMClient,
  roleName: string,
  policyNames: string[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const policyName of policyNames) {
    try {
      await iam.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
        }),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more IAM policies could not be removed");
  }
}
