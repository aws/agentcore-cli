import { z } from "zod";

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
