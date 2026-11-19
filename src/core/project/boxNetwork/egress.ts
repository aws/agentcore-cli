import { z } from "zod";
import type { BoxEgressAuth } from "./network";
import type { FailureCode } from "./types";

/** One `[egress.<name>]` `secret` table, as Box reads it. */
const BoxEgressSecretSchema = z
  .object({
    ref: z.string().min(1),
    header: z.string().min(1).optional(),
    prefix: z.string().optional(),
    placement: z.string().optional(),
    param: z.string().optional(),
    inject: z.string().optional(),
    phantom_prefix: z.string().optional(),
  })
  .strict();
export type BoxEgressSecret = z.infer<typeof BoxEgressSecretSchema>;

const BoxEgressBackendSchema = z
  .object({ url: z.string(), auth: BoxEgressSecretSchema.optional() })
  .strict();

/** One compiled `[egress.<name>]` entry, with the fields Box accepts and no others. */
export const BoxEgressEntrySchema = z
  .object({
    destinations: z.array(z.string().min(1)).min(1),
    protocol: z.enum(["http", "mcp"]).optional(),
    secret: BoxEgressSecretSchema.optional(),
    backends: z.array(BoxEgressBackendSchema).optional(),
  })
  .strict();

/** One `[mcp.<name>]` entry, of any transport. */
export const BoxMcpEntrySchema = z.object({ type: z.string() }).passthrough();

/** One compiled `[mcp.<name>]` entry with `type = "http"`, with the fields Box accepts and no others. */
export const BoxHttpMcpEntrySchema = z
  .object({
    type: z.literal("http"),
    destinations: z.array(z.string().min(1)).min(1),
    secret: BoxEgressSecretSchema.optional(),
    backends: z.array(BoxEgressBackendSchema).optional(),
  })
  .strict();

export interface Destination {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly wildcard: boolean;
}

/** Parses a Box destination: `host`, `host:port`, either with a path, or a `*` wildcard. */
export function parseDestination(text: string): Destination | undefined {
  const slash = text.indexOf("/");
  const authority = slash === -1 ? text : text.slice(0, slash);
  const path = slash === -1 ? undefined : text.slice(slash);
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return undefined;
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  const host = match[1]!;
  return { host, port, path, wildcard: host.includes("*") };
}

/**
 * Why a gateway target cannot have `host`, to follow the host in a sentence, and how to fix it;
 * `undefined` when it can. A target's endpoint takes a lower-case DNS name or IPv4 address, with
 * no trailing dot, as Box presents a host.
 */
export function targetHostProblem(
  host: string,
): { readonly why: string; readonly fix: string } | undefined {
  if (host.startsWith("[") || host.includes(":")) {
    return {
      why: "is an IPv6 address, and a gateway target cannot reach one",
      fix: "Use a host name or an IPv4 address.",
    };
  }
  if (host !== host.toLowerCase() || host.endsWith(".")) {
    return {
      why: "never matches, because Box compares hosts in lower case with no trailing dot",
      fix: `Write the host as ${JSON.stringify(host.toLowerCase().replace(/\.+$/, ""))}.`,
    };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return {
      why: "has a character that the host of a gateway target cannot have",
      fix: 'Use a host with only letters, digits, "-", and ".".',
    };
  }
  return undefined;
}

/** The host, port, and path of an `https://` endpoint, or `undefined` for any other URL. */
export function parseEndpoint(
  endpoint: string,
): { readonly host: string; readonly port: number; readonly path: string } | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === "" ? 443 : Number(url.port),
    path: url.pathname === "/" ? "" : url.pathname,
  };
}

/** The AWS endpoints the gateway signs for: each host, the API it serves, and its signing service. */
const AWS_ENDPOINTS = [
  {
    pattern: /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/,
    api: "bedrock-runtime",
    service: "bedrock",
  },
  {
    pattern: /^bedrock\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/,
    api: "bedrock-control",
    service: "bedrock",
  },
  {
    pattern: /^bedrock-agentcore(?:-control)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/,
    api: "bedrock-agentcore",
    service: "bedrock-agentcore",
  },
  {
    pattern: /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/,
    api: "lambda-url",
    service: "lambda",
  },
] as const;

/** The API of an AWS endpoint that the gateway signs for. */
export type AwsEndpointApi = (typeof AWS_ENDPOINTS)[number]["api"];

/** The API, signing service, and region of an AWS endpoint, or `undefined` for any other host. */
export function awsEndpoint(
  host: string,
): { api: AwsEndpointApi; service: string; region: string } | undefined {
  for (const { pattern, api, service } of AWS_ENDPOINTS) {
    const match = pattern.exec(host);
    if (match) return { api, service, region: match[1]! };
  }
  return undefined;
}

/** The AWS signing service and region of an AWS endpoint, or `undefined` for any other host. */
export function signingService(host: string): { service: string; region: string } | undefined {
  const endpoint = awsEndpoint(host);
  return endpoint && { service: endpoint.service, region: endpoint.region };
}

/**
 * The start of the name of each target that build adds to a Box gateway. Build manages every
 * target whose name has it, and no other.
 */
export const BOX_EGRESS_TARGET_PREFIX = "egress-";

/**
 * The gateway target name build gives `name`: {@link BOX_EGRESS_TARGET_PREFIX}, then the letters
 * and digits of `name` joined by single hyphens, at most 100 characters in all, as AgentCore
 * requires. `undefined` when nothing of `name` survives.
 */
export function targetNameFor(name: string): string | undefined {
  const cleaned = name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100 - BOX_EGRESS_TARGET_PREFIX.length)
    .replace(/-+$/, "");
  return cleaned.length > 0 ? `${BOX_EGRESS_TARGET_PREFIX}${cleaned}` : undefined;
}

export type OutboundAuthResult =
  | { readonly ok: true; readonly auth: BoxEgressAuth }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/**
 * The gateway's outbound auth for the secret of an `[egress]` entry: `aws://` signs with the
 * gateway's role for the host's service, `env://` sends the API key of the credential
 * `credentialFor` names, and no secret sends nothing. A failure's reason follows the entry's name.
 */
export function outboundAuthFor(
  secret: BoxEgressSecret | undefined,
  host: string,
  credentialFor: (variable: string) => string,
): OutboundAuthResult {
  if (!secret) return { ok: true, auth: { kind: "none" } };
  const [scheme, value = ""] = secret.ref.split("://", 2);
  if (scheme === "aws") {
    const signing = signingService(host);
    if (!signing) {
      return {
        ok: false,
        code: "UNSIGNABLE_HOST",
        reason:
          `signs requests to ${host} with ${secret.ref}, and the gateway signs only for Bedrock, ` +
          "AgentCore, and Lambda function URL hosts. Use an env:// secret for this host, or " +
          "remove the secret.",
      };
    }
    return { ok: true, auth: { kind: "iam", ...signing } };
  }
  if (scheme === "env" && value.length > 0) {
    if (secret.placement !== undefined && secret.placement !== "header") {
      return {
        ok: false,
        code: "UNSUPPORTED_SECRET_PLACEMENT",
        reason:
          `sends its secret as ${secret.placement}, and a gateway target sends an API key only ` +
          'in a header. Set `placement` to "header", if the host takes the key in a header.',
      };
    }
    const header = secret.header ?? "Authorization";
    // Box's prefix is the literal text before the key ("Bearer "); the gateway's is the word.
    const boxPrefix = secret.prefix ?? (header.toLowerCase() === "authorization" ? "Bearer " : "");
    const prefix = boxPrefix.trimEnd();
    return {
      ok: true,
      auth: {
        kind: "apiKey",
        credentialName: credentialFor(value),
        variable: value,
        header,
        ...(prefix.length > 0 && { prefix }),
      },
    };
  }
  return {
    ok: false,
    code: "UNSUPPORTED_SECRET",
    reason:
      scheme === "credsd"
        ? `reads its secret from ${secret.ref}, and the gateway cannot read credsd. Use an ` +
          "env:// secret, which build stores as an API key credential."
        : scheme === "env"
          ? `has the secret ${secret.ref}, which names no variable. Write env://<VARIABLE>.`
          : `has the secret ${secret.ref}, and the gateway takes only an aws:// or env:// ` +
            "secret. Use one of them.",
  };
}
