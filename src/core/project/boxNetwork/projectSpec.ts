import type { AgentCoreGatewayTarget, OutboundAuth } from "../../../projectSchemas/gateway";
import type { BoxEgressAuth, BoxNetworkHost } from "./network";

/** The passthrough target build writes for a host. */
export function gatewayTargetFor(
  host: BoxNetworkHost & { readonly target: string },
): AgentCoreGatewayTarget {
  const outboundAuth = targetOutboundAuth(host.outboundAuth);
  return {
    name: host.target,
    targetType: "passthrough",
    passthrough: { endpoint: `https://${host.authority}`, protocolType: "CUSTOM" },
    ...(outboundAuth && { outboundAuth }),
  };
}

/** No auth omits `outboundAuth`, so the gateway gets no credential provider for the target. */
export function targetOutboundAuth(auth: BoxEgressAuth): OutboundAuth | undefined {
  switch (auth.kind) {
    case "iam":
      return {
        type: "GATEWAY_IAM_ROLE",
        service: auth.service,
        ...(auth.region !== undefined && { region: auth.region }),
      };
    case "apiKey":
      return {
        type: "API_KEY",
        credentialName: auth.credentialName,
        location: "HEADER",
        parameterName: auth.header,
        ...(auth.prefix !== undefined && { prefix: auth.prefix }),
      };
    case "none":
      return undefined;
  }
}

/** Whether two targets send the same credential. No auth and `NONE` are the same. */
export function sameOutboundAuth(a: OutboundAuth | undefined, b: OutboundAuth | undefined) {
  return outboundAuthKey(a) === outboundAuthKey(b);
}

function outboundAuthKey(auth: OutboundAuth | undefined): string {
  if (auth === undefined || auth.type === "NONE") return "NONE";
  return JSON.stringify([
    auth.type,
    auth.credentialName,
    auth.service,
    auth.region,
    auth.type === "API_KEY" ? (auth.location ?? "HEADER") : auth.location,
    auth.parameterName,
    auth.prefix,
    auth.scopes,
  ]);
}

/**
 * What a target sends to its host, in words for a message: `no credential`, `requests signed with
 * the gateway's role for bedrock`, or `the API key credential 'github' in the header
 * Authorization`.
 */
export function outboundAuthWords(auth: OutboundAuth | undefined): string {
  if (auth === undefined || auth.type === "NONE") return "no credential";
  switch (auth.type) {
    case "GATEWAY_IAM_ROLE":
      return `requests signed with the gateway's role${auth.service ? ` for ${auth.service}` : ""}`;
    case "API_KEY": {
      const where =
        (auth.location ?? "HEADER") === "HEADER"
          ? `the header ${auth.parameterName ?? "Authorization"}`
          : `the query parameter ${auth.parameterName ?? "(none)"}`;
      const prefix = auth.prefix !== undefined ? ` with the prefix ${auth.prefix}` : "";
      return `the API key credential '${auth.credentialName ?? "(none)"}' in ${where}${prefix}`;
    }
    default:
      return auth.credentialName !== undefined
        ? `the ${auth.type} credential '${auth.credentialName}'`
        : `a ${auth.type} credential`;
  }
}
