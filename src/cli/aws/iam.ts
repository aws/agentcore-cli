import { ValidationError } from '../../lib/errors/types.js';
import stableStringify from 'fast-json-stable-stringify';

export type IamPolicyDocument = Record<string, unknown>;

function parseIamPolicyDocument(policy: unknown): unknown {
  if (typeof policy !== 'string') return policy;

  try {
    return JSON.parse(decodeURIComponent(policy));
  } catch {
    return undefined;
  }
}

/**
 * Reject an IAM role whose trust policy does not structurally match the expected policy.
 *
 * IAM may return AssumeRolePolicyDocument as an object or a URL-encoded JSON string.
 */
export function validateIamRoleTrustPolicy(
  actualPolicy: unknown,
  expectedPolicy: IamPolicyDocument,
  roleName: string,
  remediation: string
): void {
  const parsedPolicy = parseIamPolicyDocument(actualPolicy);
  if (
    parsedPolicy !== null &&
    typeof parsedPolicy === 'object' &&
    !Array.isArray(parsedPolicy) &&
    stableStringify(parsedPolicy) === stableStringify(expectedPolicy)
  ) {
    return;
  }

  throw new ValidationError(
    `Refusing to reuse existing IAM role "${roleName}" because its trust policy does not match ` +
      `the policy required by AgentCore. ${remediation}`
  );
}
