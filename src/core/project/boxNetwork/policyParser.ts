import { parsePolicy, type SourceSpan, type Statement } from "./dogwood";
import type { BoxNetworkFailure } from "./network";
import {
  boxGeneratedNetworkRules,
  joinPolicyText,
  placeOfSpan,
  type ParsedProfile,
  type PolicySegment,
} from "./profileParser";

/** The policy files of a parsed profile, with the rules the box CLI adds for its routes. */
export interface ParsedPolicy {
  readonly profile: ParsedProfile;
  /** The policy files' statements, then the rules the box CLI adds for each route. */
  readonly statements: readonly Statement[];
  /** Where each policy file sits in the text the statements came from. */
  readonly segments: readonly PolicySegment[];
}

/** One policy file of the profile, by its path from the project root, and its text. */
export interface PolicyFileText {
  readonly file: string;
  readonly text: string;
}

/** Parses the profile's policy files with the rules the box CLI adds, and every syntax error. */
export function parsePolicyFiles(
  profile: ParsedProfile,
  files: readonly PolicyFileText[],
): { readonly parsed: ParsedPolicy; readonly failures: readonly BoxNetworkFailure[] } {
  const joined = joinPolicyText(files, boxGeneratedNetworkRules(profile.egress, profile.mcp));
  const policy = parsePolicy(joined.text);
  return {
    parsed: { profile, statements: policy.statements, segments: joined.segments },
    failures: policy.errors.map((error) => ({
      code: "PARSE_ERROR",
      reason: error.message,
      place: placeOf(joined.segments, error.span),
    })),
  };
}

/** Where a span of the parsed statements is: `file:line:column`, or a rule the box CLI adds. */
export function placeOf(segments: readonly PolicySegment[], span: SourceSpan): string {
  return placeOfSpan(segments, span) ?? "a rule the box CLI adds";
}
