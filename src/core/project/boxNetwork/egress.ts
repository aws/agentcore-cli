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

/** One compiled `[egress.<name>]` entry, with the fields Box accepts and no others. */
export const BoxEgressEntrySchema = z
  .object({
    destinations: z.array(z.string().min(1)).min(1),
    protocol: z.enum(["http", "mcp"]).optional(),
    secret: BoxEgressSecretSchema.optional(),
    backends: z
      .array(z.object({ url: z.string(), auth: BoxEgressSecretSchema.optional() }).strict())
      .optional(),
  })
  .strict();

/** One `[mcp.<name>]` entry. Only an `http` server's destinations matter here. */
export const BoxMcpEntrySchema = z
  .object({ type: z.string(), destinations: z.array(z.string()).optional() })
  .passthrough();

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
 * Why a gateway target cannot have `host`, or `undefined` when it can: a target's endpoint takes a
 * lower-case DNS name or IPv4 address, with no trailing dot, as Box presents a host.
 */
export function targetHostProblem(host: string): string | undefined {
  if (host.startsWith("[") || host.includes(":")) {
    return `${host} is an IPv6 address, and a gateway target's endpoint takes no IPv6 address`;
  }
  if (host !== host.toLowerCase() || host.endsWith(".")) {
    return `Box presents ${host} in lower case with no trailing dot, so it never matches; write ${host.toLowerCase().replace(/\.+$/, "")}`;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return `${host} has a character other than a letter, a digit, '-', or '.', which a gateway target's endpoint refuses`;
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

/** The AWS signing service and region of an AWS endpoint, or `undefined` for any other host. */
export function signingService(host: string): { service: string; region: string } | undefined {
  const rules: [RegExp, string][] = [
    [/^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/, "bedrock"],
    [/^bedrock\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/, "bedrock"],
    [
      /^bedrock-agentcore(?:-control)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/,
      "bedrock-agentcore",
    ],
    [/^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/, "lambda"],
  ];
  for (const [pattern, service] of rules) {
    const match = pattern.exec(host);
    if (match) return { service, region: match[1]! };
  }
  return undefined;
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
 * The gateway's outbound auth for an entry's secret: `aws://` signs with the gateway's role for the
 * host's service, `env://` sends the API key of the credential `credentialFor` names, and no secret
 * sends nothing.
 */
export function outboundAuthFor(
  secret: BoxEgressSecret | undefined,
  host: string,
  credentialFor: (variable: string) => string | undefined,
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
          `it signs ${host} with ${secret.ref}, but the host is not an AWS endpoint the gateway ` +
          "can sign for: bedrock, bedrock-runtime, bedrock-agentcore, or a Lambda function URL",
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
          `its secret is placed as ${secret.placement}, and a gateway API key target in ` +
          "agentcore.json sends its key only in a header",
      };
    }
    const credentialName = credentialFor(value);
    if (credentialName === undefined) {
      return {
        ok: false,
        code: "API_KEY_CREDENTIAL_MISSING",
        reason:
          `its secret ${secret.ref} needs an API key credential named after the entry, and the ` +
          "entry's name is not a credential name (3 to 128 letters, digits, '-', or '_'), or " +
          "agentcore.json has a credential of another kind with that name. Rename the entry",
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
        credentialName,
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
        ? `its secret ${secret.ref} comes from credsd, which the gateway cannot read`
        : `its secret ${secret.ref} names no scheme the gateway can use (aws:// or env://)`,
  };
}
