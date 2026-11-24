import { parsePolicy, type SourceSpan, type Statement } from "./dogwood";
import type { ParsedProfile } from "./profileParser";
import type { BoxNetworkFailure } from "./types";

/** Box's resolved policy, beside the profile it belongs to. */
export interface ParsedPolicy {
  readonly profile: ParsedProfile;
  /** The statements of Box's resolved policy. */
  readonly statements: readonly Statement[];
  /**
   * The `file:line:column` of each statement that a policy file of the profile holds, by the
   * `line:column` of its span in Box's policy.
   */
  readonly places: ReadonlyMap<string, string>;
}

/** One policy file of the profile, by its path from the project root, and its text. */
export interface PolicyFileText {
  readonly file: string;
  readonly text: string;
}

/**
 * Parses Box's resolved `policy`, and places each of its statements in the profile's own policy
 * `files`: at the statement there with the same `@id`, or the same text when it has none. A
 * statement that no file holds is a rule Box adds. Each syntax error is at its place in a file;
 * one in Box's policy, when no file has one, is placed at the profile.
 */
export function parseResolvedPolicy(
  profile: ParsedProfile,
  policy: string,
  files: readonly PolicyFileText[],
): { readonly parsed: ParsedPolicy; readonly failures: readonly BoxNetworkFailure[] } {
  const failures: BoxNetworkFailure[] = [];
  const held = new Map<string, string[]>();
  for (const { file, text } of files) {
    const own = parsePolicy(text);
    for (const statement of own.statements) {
      const key = matchKey(statement);
      held.set(key, [...(held.get(key) ?? []), placeIn(file, statement.span)]);
    }
    for (const error of own.errors) {
      failures.push({
        code: "PARSE_ERROR",
        reason: `Syntax error: ${error.message}. Correct the rule at this place.`,
        place: placeIn(file, error.span),
      });
    }
  }
  const resolved = parsePolicy(policy);
  if (failures.length === 0) {
    for (const error of resolved.errors) {
      failures.push({
        code: "PARSE_ERROR",
        reason:
          `Build cannot read a rule that Box or a pack adds to this profile (syntax error: ` +
          `${error.message}). Update the AgentCore CLI, then retry.`,
        place: profile.path,
      });
    }
  }
  const places = new Map<string, string>();
  for (const statement of resolved.statements) {
    const place = held.get(matchKey(statement))?.shift();
    if (place !== undefined) places.set(spanKey(statement.span), place);
  }
  return { parsed: { profile, statements: resolved.statements, places }, failures };
}

/**
 * The `file:line:column` of the statement at `span` of Box's policy in a policy file of the
 * profile, or `undefined` for a rule that Box adds.
 */
export function placeOf(
  parsed: Pick<ParsedPolicy, "places">,
  span: SourceSpan,
): string | undefined {
  return parsed.places.get(spanKey(span));
}

/** What pairs a statement of Box's policy with one of a policy file. */
function matchKey(statement: Statement): string {
  const id = statement.annotations.id;
  return id !== undefined ? `id ${id}` : `text ${statement.text}`;
}

function spanKey(span: SourceSpan): string {
  return `${span.line}:${span.column}`;
}

function placeIn(file: string, span: SourceSpan): string {
  return `${file}:${span.line}:${span.column}`;
}
