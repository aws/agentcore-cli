// Helpers for reading ids out of AgentCore ARNs. The service reports most
// links between resources as ARNs (a harness's runtime, memory, gateway and
// credential providers; a project's deployed resources) while the CLI's detail
// routes and Core clients take the bare service id, so screens go through
// these to turn one into the other. Values that are not ARNs pass through
// unchanged so callers can hand over ids they already have.

// An ARN is arn:<partition>:<service>:<region>:<account>:<resource>; the
// resource part may itself contain colons and slashes.
const ARN_PATTERN = /^arn:([^:]*):([^:]*):([^:]*):([^:]*):(.+)$/;

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

export function parseArn(value: string): ParsedArn | undefined {
  const match = ARN_PATTERN.exec(value);
  if (!match) return undefined;
  const [, partition = "", service = "", region = "", account = "", resource = ""] = match;
  return { partition, service, region, account, resource };
}

// serviceIdFromArn returns the resource path after the type prefix — for
// arn:aws:bedrock-agentcore:<region>:<account>:memory/<memoryId> that is
// `<memoryId>`, which is what the detail routes and Core clients take. Ids that
// are not ARNs (a gateway target's id, for one) pass through unchanged.
export function serviceIdFromArn(id: string): string {
  const resource = parseArn(id)?.resource;
  const slash = resource?.indexOf("/") ?? -1;
  return resource !== undefined && slash >= 0 ? resource.slice(slash + 1) : id;
}

// resourceNameFromArn returns the last path segment of an ARN's resource, for
// resources addressed by name under a longer path: a credential provider's ARN
// is arn:…:token-vault/<vault>/apikeycredentialprovider/<name> and its routes
// and Core calls want `<name>`. Non-ARNs pass through unchanged.
export function resourceNameFromArn(id: string): string {
  const resource = parseArn(id)?.resource;
  if (resource === undefined) return id;
  return resource.slice(resource.lastIndexOf("/") + 1);
}

// regionFromArn reads the region an ARN was minted in, or undefined for a
// non-ARN or a global (regionless) ARN.
export function regionFromArn(arn: string): string | undefined {
  const region = parseArn(arn)?.region;
  return region ? region : undefined;
}

export type CredentialProviderType = "api-key" | "oauth2";

// credentialProviderTypeFromArn tells an API key provider ARN apart from an
// OAuth2 one by the path segment under the token vault; the two have different
// detail screens and Core calls but the ARN is the only thing a linking
// resource carries.
export function credentialProviderTypeFromArn(arn: string): CredentialProviderType | undefined {
  const segments = parseArn(arn)?.resource.split("/") ?? [];
  if (segments[0] !== "token-vault") return undefined;
  if (segments.includes("apikeycredentialprovider")) return "api-key";
  if (segments.includes("oauth2credentialprovider")) return "oauth2";
  return undefined;
}
