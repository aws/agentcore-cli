/**
 * Utilities for parsing CloudFormation logical IDs.
 *
 * This is a minimal copy of the logical ID utilities needed by the CLI
 * for parsing stack outputs. The full implementation lives in
 * agentcore-cdk.
 */

const LOGICAL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MAX_LOGICAL_ID_LENGTH = 255;

function assertLogicalId(id: string): void {
  if (id.length === 0 || id.length > MAX_LOGICAL_ID_LENGTH || !LOGICAL_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid CloudFormation logical ID: "${id}". Must start with a letter, contain only alphanumerics, and be <= ${MAX_LOGICAL_ID_LENGTH} characters.`
    );
  }
}

/**
 * Converts a name to a valid logical ID part by converting to PascalCase.
 * Examples: "my-gateway" -> "MyGateway", "my_tool" -> "MyTool"
 */
function toLogicalIdPart(name: string): string {
  return name
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Converts dynamic names to valid CloudFormation logical IDs in PascalCase.
 */
export function toPascalId(...parts: string[]): string {
  if (parts.length === 0) {
    throw new Error('toPascalId requires at least one part');
  }

  const id = parts.map(toLogicalIdPart).join('');
  assertLogicalId(id);
  return id;
}
