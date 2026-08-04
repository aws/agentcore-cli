import { createHash } from "node:crypto";
import {
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";

const POLICY_HASH_LENGTH = 32;
const MAX_POLICY_NAME_LENGTH = 128;

export type InlinePolicySwapConfig = {
  roleName: string;
  policyNamePrefix: string;
};

export class InlinePolicySwap {
  constructor(
    private readonly iam: IAMClient,
    private readonly config: InlinePolicySwapConfig,
  ) {}

  static candidatePolicyName(policyNamePrefix: string, policyDocument: string): string {
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

  async run<T>(policyDocument: string | undefined, operation: () => Promise<T>): Promise<T> {
    const existingPolicyNames = (await this.listPolicyNames()).filter((name) =>
      this.isFamilyMember(name),
    );
    const candidateName = policyDocument
      ? InlinePolicySwap.candidatePolicyName(this.config.policyNamePrefix, policyDocument)
      : undefined;
    const candidateExisted = candidateName ? existingPolicyNames.includes(candidateName) : false;

    if (candidateName) {
      await this.iam.send(
        new PutRolePolicyCommand({
          RoleName: this.config.roleName,
          PolicyName: candidateName,
          PolicyDocument: policyDocument,
        }),
      );
    }

    let result: T;
    try {
      result = await operation();
    } catch (operationError) {
      if (candidateName && !candidateExisted) {
        try {
          await this.deletePolicies([candidateName]);
        } catch (rollbackError) {
          throw new AggregateError(
            [operationError, rollbackError],
            "Operation failed and its candidate IAM policy could not be removed",
          );
        }
      }
      throw operationError;
    }

    const previousPolicyNames = candidateName
      ? existingPolicyNames.filter((name) => name !== candidateName)
      : existingPolicyNames;
    try {
      await this.deletePolicies(previousPolicyNames);
    } catch (cleanupError) {
      throw new AggregateError(
        [cleanupError],
        "Operation succeeded but previous IAM policies could not be removed",
      );
    }
    return result;
  }

  private async listPolicyNames(): Promise<string[]> {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const response = await this.iam.send(
        new ListRolePoliciesCommand({
          RoleName: this.config.roleName,
          ...(marker ? { Marker: marker } : {}),
        }),
      );
      names.push(...(response.PolicyNames ?? []));
      marker = response.IsTruncated ? response.Marker : undefined;
    } while (marker);
    return names;
  }

  private isFamilyMember(name: string): boolean {
    if (name === this.config.policyNamePrefix) return true;
    const suffix = name.slice(this.config.policyNamePrefix.length + 1);
    return name.startsWith(`${this.config.policyNamePrefix}-`) && /^[0-9a-f]{32}$/.test(suffix);
  }

  private async deletePolicies(policyNames: string[]): Promise<void> {
    const errors: unknown[] = [];
    for (const policyName of policyNames) {
      try {
        await this.iam.send(
          new DeleteRolePolicyCommand({
            RoleName: this.config.roleName,
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
}
