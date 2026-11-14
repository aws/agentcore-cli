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
      return { type: "GATEWAY_IAM_ROLE", service: auth.service, region: auth.region };
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

/** A target's outbound auth as one line of text, such as `API_KEY (github, header Authorization)`. */
export function outboundAuthText(auth: OutboundAuth | undefined): string {
  if (auth === undefined || auth.type === "NONE") return "NONE";
  switch (auth.type) {
    case "GATEWAY_IAM_ROLE":
      return `GATEWAY_IAM_ROLE (${[auth.service, auth.region].filter(Boolean).join(", ")})`;
    case "API_KEY":
      return `API_KEY (${auth.credentialName ?? "no credential"}, ${(auth.location ?? "HEADER") === "HEADER" ? "header" : "query parameter"} ${auth.parameterName ?? "Authorization"}${auth.prefix !== undefined ? `, prefix ${auth.prefix}` : ""})`;
    default:
      return auth.credentialName !== undefined
        ? `${auth.type} (${auth.credentialName})`
        : auth.type;
  }
}
