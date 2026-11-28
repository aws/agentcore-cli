/**
 * Where a rule or an entry of the box profile is in the user's own files, and the words that name
 * it at the start of a message: a rule of a policy file at its line there, and a rule that Box
 * adds at the part of the profile that makes Box add it.
 */
import type { SourceSpan } from "./dogwood";
import { placeOf, type ParsedPolicy } from "./policyParser";

/**
 * The `@id`s of the cloud metadata forbids that Box's security guide recommends. Box writes no
 * metadata rule into a profile itself; the messages below still name a rule of either id that no
 * policy file holds as one Box adds to every profile.
 */
export const BOX_METADATA_RULE_IDS: ReadonlySet<string> = new Set([
  "metadata_hosts",
  "metadata_addresses",
]);

/** A place, `file:line:column` or a file, and the words that name what is there. */
export interface Described {
  readonly place: string;
  /** Starts a sentence: `The rule "wild"`, `[egress.github]`. */
  readonly subject: string;
}

/** Why a rule that no policy file holds is in Box's policy. */
export type RuleOrigin =
  /** Box adds it: `for [egress.github]`, or `to every profile`. */
  | { readonly by: "box"; readonly purpose: string; readonly place: string }
  | { readonly by: "pack"; readonly place: string };

/** Where the profile sets `[<table>.<name>]`, or `packs` for an entry that a pack adds. */
export function describeEntry(
  parsed: Pick<ParsedPolicy, "profile">,
  table: "egress" | "mcp",
  name: string,
): Described {
  const entry = `[${table}.${name}]`;
  const place = parsed.profile.places?.entries.get(`${table}.${name}`);
  if (place !== undefined) return { place, subject: entry };
  return { place: packsPlace(parsed), subject: `${entry}, which a pack in \`packs\` adds,` };
}

/** Where the rule `ruleId` at `span` of Box's policy is, and its name. */
export function describeRule(parsed: ParsedPolicy, ruleId: string, span?: SourceSpan): Described {
  const statement =
    (span &&
      parsed.statements.find(
        (candidate) => candidate.span.line === span.line && candidate.span.column === span.column,
      )) ??
    parsed.statements.find((candidate) => candidate.id === ruleId);
  const place = statement && placeOf(parsed, statement.span);
  // A rule with no @id has only the id the parser gives it, which the user never wrote.
  const named = statement === undefined || statement.annotations.id !== undefined;
  if (place !== undefined) {
    return { place, subject: named ? `The rule ${JSON.stringify(ruleId)}` : "This rule" };
  }
  const origin = ruleOrigin(parsed, ruleId);
  const adds = origin.by === "box" ? `Box adds ${origin.purpose}` : "a pack in `packs` adds";
  return {
    place: origin.place,
    subject: named ? `The rule ${JSON.stringify(ruleId)}, which ${adds},` : `A rule that ${adds}`,
  };
}

/**
 * What makes Box add the rule `ruleId`, which no policy file holds: an `[egress]` or `[mcp]` entry
 * for its `route_` and `mcp_` rules, every profile for the metadata rules, and a pack otherwise.
 * The entry is one Box resolves or one the profile sets, as Box writes some routes only as rules.
 */
export function ruleOrigin(parsed: Pick<ParsedPolicy, "profile">, ruleId: string): RuleOrigin {
  const entries: ["egress" | "mcp", RegExp][] = [
    ["egress", /^route_(.+)_(?:connect|request)$/],
    ["mcp", /^mcp_(.+)_(?:connect|request|call)$/],
  ];
  for (const [table, pattern] of entries) {
    const name = pattern.exec(ruleId)?.[1];
    if (name === undefined) continue;
    const resolved = Object.hasOwn(parsed.profile[table], name);
    if (!resolved && !parsed.profile.places?.entries.has(`${table}.${name}`)) continue;
    return {
      by: "box",
      purpose: `for [${table}.${name}]`,
      place: describeEntry(parsed, table, name).place,
    };
  }
  if (BOX_METADATA_RULE_IDS.has(ruleId)) {
    return { by: "box", purpose: "to every profile", place: parsed.profile.path };
  }
  return { by: "pack", place: packsPlace(parsed) };
}

function packsPlace(parsed: Pick<ParsedPolicy, "profile">): string {
  return parsed.profile.places?.packs ?? parsed.profile.path;
}
