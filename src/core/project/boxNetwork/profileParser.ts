/**
 * Reads the network inputs of a box profile as the box CLI compiles them: the `[egress]` and
 * `[mcp]` tables after the packs merge in, the policy files the profile names, and the rules the
 * box CLI adds for each route. {@link convertBoxNetworkPolicy} takes the result.
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The pack `agentcore create` names for a Bedrock agent. It declares the `[egress.bedrock]` route. */
const BOX_BEDROCK_PACK = "box/bedrock";

/** The region `box/bedrock` uses when the profile sets no `[options] bedrock.region`. */
const BOX_BEDROCK_PACK_DEFAULT_REGION = "us-west-2";

/** The secret `box/bedrock` declares, which a profile replaces to sign the calls instead. */
const BOX_BEDROCK_PACK_SECRET = "env://AWS_BEARER_TOKEN_BEDROCK";

/** The box profile, from the project root. */
export const BOX_PROFILE_PATH = ".box/profile.toml";

/** The packs the converter reads: `box/base` declares no route, and `box/bedrock` one. */
const KNOWN_PACKS: ReadonlySet<string> = new Set(["box/base", BOX_BEDROCK_PACK]);

export interface ParsedProfile {
  /** `[egress]`, with the route of `box/bedrock` merged under the profile's own. */
  readonly egress: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  /** The policy files, relative to the profile's folder, in the order the profile names them. */
  readonly policyFiles: readonly string[];
}

/** A failure of the profile itself, at its line when the converter can find it. */
export interface ProfileFailure {
  readonly code: "INVALID_PROFILE" | "UNSUPPORTED_PACK" | "UNSUPPORTED_POLICY_KEY";
  readonly reason: string;
  readonly place: string;
}

const EMPTY_PROFILE: ParsedProfile = { egress: {}, mcp: {}, policyFiles: [] };

/** The network inputs of the box profile `text`, and every failure of the profile. */
export function parseProfile(text: string): {
  readonly profile: ParsedProfile;
  readonly failures: readonly ProfileFailure[];
} {
  const fail = (code: ProfileFailure["code"], reason: string, key?: string) => ({
    profile: EMPTY_PROFILE,
    failures: [{ code, reason, place: placeOfKey(text, key) }],
  });
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const at = error as { line?: number; column?: number; message?: string };
    const place =
      at.line !== undefined ? `${BOX_PROFILE_PATH}:${at.line}:${at.column ?? 1}` : BOX_PROFILE_PATH;
    const reason = (at.message ?? String(error)).split("\n")[0]!;
    return { profile: EMPTY_PROFILE, failures: [{ code: "INVALID_PROFILE", reason, place }] };
  }
  const packs = table.packs ?? [];
  if (!Array.isArray(packs) || !packs.every((pack) => typeof pack === "string")) {
    return fail("INVALID_PROFILE", "`packs` is not a list of pack names", "packs");
  }
  for (const key of ["egress", "mcp"] as const) {
    if (table[key] !== undefined && !isTable(table[key])) {
      return fail("INVALID_PROFILE", `\`${key}\` is not a table`, key);
    }
  }
  if (table.policy !== undefined) {
    return fail(
      "UNSUPPORTED_POLICY_KEY",
      "the profile names `policy`, which the box CLI refuses; list the files under `policies`",
      "policy",
    );
  }
  const policyFiles = policyFilesOf(table);
  if (!policyFiles.ok) return fail("INVALID_PROFILE", policyFiles.reason, "policies");

  const failures: ProfileFailure[] = (packs as string[])
    .filter((pack) => !KNOWN_PACKS.has(pack))
    .map((pack) => ({
      code: "UNSUPPORTED_PACK" as const,
      reason:
        `it names the pack ${pack}, whose routes and rules build does not read; ` +
        "write its [egress] entries and rules into the profile, and remove the pack",
      place: placeOfKey(text, "packs"),
    }));
  let egress: Record<string, unknown> = {};
  if ((packs as string[]).includes(BOX_BEDROCK_PACK)) egress = bedrockPackEgress(table);
  egress = merged(egress, (table.egress as Record<string, unknown> | undefined) ?? {});
  return {
    profile: {
      egress,
      mcp: (table.mcp as Record<string, unknown> | undefined) ?? {},
      policyFiles: policyFiles.files,
    },
    failures,
  };
}

/** `.box/profile.toml:<line>` of the first line that sets `key`, or the file when none does. */
function placeOfKey(text: string, key: string | undefined): string {
  if (key === undefined) return BOX_PROFILE_PATH;
  const index = text.split("\n").findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  return index === -1 ? BOX_PROFILE_PATH : `${BOX_PROFILE_PATH}:${index + 1}`;
}

/** The `[egress.bedrock]` route of `box/bedrock`, for the region the profile's `[options]` set. */
function bedrockPackEgress(table: Record<string, unknown>): Record<string, unknown> {
  const options = isTable(table.options) ? table.options : {};
  const bedrock = isTable(options.bedrock) ? options.bedrock : {};
  const quoted = options["bedrock.region"];
  const region =
    typeof bedrock.region === "string"
      ? bedrock.region
      : typeof quoted === "string"
        ? quoted
        : BOX_BEDROCK_PACK_DEFAULT_REGION;
  return {
    bedrock: {
      destinations: [`bedrock-runtime.${region}.amazonaws.com`],
      secret: { ref: BOX_BEDROCK_PACK_SECRET },
    },
  };
}

/** The profile's `policies`, as the box CLI reads it: files inside the profile's folder. */
function policyFilesOf(
  table: Record<string, unknown>,
): { ok: true; files: string[] } | { ok: false; reason: string } {
  const named = table.policies ?? [];
  if (!Array.isArray(named) || !named.every((file) => typeof file === "string" && file !== "")) {
    return { ok: false, reason: "`policies` must name policy files, as nonempty paths" };
  }
  const files: string[] = [];
  for (const file of named as string[]) {
    const normal = posix.normalize(file.replace(/\\/g, "/"));
    if (posix.isAbsolute(normal) || normal === ".." || normal.startsWith("../")) {
      return {
        ok: false,
        reason: `\`policies\` names ${JSON.stringify(file)}, which is outside the profile's folder`,
      };
    }
    if (files.includes(normal)) {
      return { ok: false, reason: `\`policies\` names ${JSON.stringify(file)} twice` };
    }
    files.push(normal);
  }
  return { ok: true, files };
}

/** `over` merged into `base`: tables merge key by key, and any other value replaces. */
function merged(base: Record<string, unknown>, over: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const old = out[key];
    out[key] = isTable(old) && isTable(value) ? merged(old, value) : value;
  }
  return out;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NET_CONNECT = 'action == Box::Action::"net:connect"';
const HTTP_REQUEST = 'action == Box::Action::"http:request"';

/** The box CLI's own network forbids. The converter leaves both to Box. */
const BOX_NETWORK_BASE_RULES = [
  `@id("metadata_hosts") forbid (principal, ${NET_CONNECT}, resource) when { context.input.host == "metadata.google.internal" || context.input.host == "metadata.azure.internal" };`,
  `@id("metadata_addresses") forbid (principal, ${NET_CONNECT}, resource) when { (context.input has ip4 && context.input.ip4 like "169.254.*") || (context.input has ip6 && (context.input.ip6 == "fd00:ec2::254" || context.input.ip6 like "fe8*" || context.input.ip6 like "fe9*" || context.input.ip6 like "fea*" || context.input.ip6 like "feb*")) };`,
];

/**
 * The network rules the box CLI compiles into `policy.dw` beside the profile's own: its base
 * forbids, and a `net:connect` and an `http:request` permit for each `[egress]` route and each
 * HTTP `[mcp]` server, from their `destinations`. A destination that is a URL gets no rule, as the
 * box CLI refuses it; the converter then fails its entry.
 */
export function boxGeneratedNetworkRules(
  egress: Record<string, unknown>,
  mcp: Record<string, unknown>,
): string {
  const rules = [...BOX_NETWORK_BASE_RULES];
  for (const [name, entry] of Object.entries(egress)) {
    rules.push(...reachRules(`route_${name}`, destinationsOf(entry)));
  }
  for (const [name, entry] of Object.entries(mcp)) {
    if (!isTable(entry) || entry.type !== "http") continue;
    rules.push(...reachRules(`mcp_${name}`, destinationsOf(entry)));
  }
  return rules.join("\n") + "\n";
}

function destinationsOf(entry: unknown): string[] {
  if (!isTable(entry) || !Array.isArray(entry.destinations)) return [];
  return entry.destinations.filter((d): d is string => typeof d === "string");
}

function reachRules(prefix: string, destinations: readonly string[]): string[] {
  if (destinations.length === 0 || destinations.some((d) => d.includes("://"))) return [];
  const connect: string[] = [];
  const request: string[] = [];
  for (const destination of destinations) {
    const authority = destination.split("/")[0] ?? destination;
    const colon = authority.lastIndexOf(":");
    const hasPort = colon >= 0 && /^\d+$/.test(authority.slice(colon + 1));
    const host = hasPort ? authority.slice(0, colon) : authority;
    const port = hasPort ? Number(authority.slice(colon + 1)) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
    const matches = host.startsWith("*.")
      ? `context.input.host like ${literal(host)}`
      : `context.input.host == ${literal(host)}`;
    connect.push(`(${matches} && context.input.port == ${port})`);
    request.push(matches);
  }
  return [
    `@id(${literal(`${prefix}_connect`)}) permit (principal, ${NET_CONNECT}, resource) when { ${connect.join(" || ")} };`,
    `@id(${literal(`${prefix}_request`)}) permit (principal, ${HTTP_REQUEST}, resource) when { ${request.join(" || ")} };`,
  ];
}

/** A Cedar string literal, as the box CLI writes one. */
function literal(text: string): string {
  return JSON.stringify(text);
}

/** One policy file inside the joined policy text: its name and the lines it holds there. */
export interface PolicySegment {
  readonly file: string;
  /** The joined text's line, from 1, that holds the file's first line. */
  readonly firstLine: number;
  readonly lineCount: number;
}

/**
 * The policy files, then `generated`, as one policy text, with the place of each file in it, so a
 * span in the text maps back to a file's line.
 */
export function joinPolicyText(
  files: readonly { readonly file: string; readonly text: string }[],
  generated: string,
): { text: string; segments: PolicySegment[] } {
  let text = "";
  let line = 1;
  const segments: PolicySegment[] = [];
  for (const { file, text: content } of files) {
    const ended = content.endsWith("\n") || content === "" ? content : `${content}\n`;
    const lineCount = ended.split("\n").length - 1;
    segments.push({ file, firstLine: line, lineCount });
    text += ended;
    line += lineCount;
  }
  return { text: text + generated, segments };
}

/** Where a span of the joined text is: `file:line:column`, or `undefined` for a generated rule. */
export function placeOfSpan(
  segments: readonly PolicySegment[],
  span: { readonly line: number; readonly column: number },
): string | undefined {
  const segment = segments.find(
    (s) => span.line >= s.firstLine && span.line < s.firstLine + s.lineCount,
  );
  if (!segment) return undefined;
  return `${segment.file}:${span.line - segment.firstLine + 1}:${span.column}`;
}
