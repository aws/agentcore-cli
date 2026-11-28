import { describe, expect, test } from "bun:test";
import { parseResolvedPolicy, placeOf, type PolicyFileText } from "./policyParser";

const NC = 'action == Box::Action::"net:connect"';
const HR = 'action == Box::Action::"http:request"';
const NO_ADMIN = `@id("no_admin") forbid (principal, ${HR}, resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };`;
const MORE = `@id("more_rule") forbid (principal, ${HR}, resource) when { context.input.host == "example.com" };`;

/** Box's policy as box prints it for two policy files and the route `github`. */
const RESOLVED = [
  "// No admin paths on GitHub.",
  NO_ADMIN,
  "",
  "// more",
  "",
  MORE,
  "",
  '@id("shell_commands") permit (principal, action == Box::Action::"shell:exec", resource);',
  `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };`,
  `@id("route_github_request") permit (principal, ${HR}, resource) when { context.input.host == "api.github.com" };`,
  "",
].join("\n");
const FILES: PolicyFileText[] = [
  { file: ".box/agent/local/policy.dw", text: `// No admin paths on GitHub.\n${NO_ADMIN}\n` },
  { file: ".box/agent/local/sub/more.dw", text: `// more\n\n${MORE}\n` },
];
const NO_ROUTES = {
  path: ".box/agent/local/profile.toml",
  egress: {},
  mcp: {},
  policyFiles: ["policy.dw", "sub/more.dw"],
};

function parsed(policy: string, files: PolicyFileText[], egress: Record<string, unknown> = {}) {
  return parseResolvedPolicy({ ...NO_ROUTES, egress }, policy, files);
}

/** Each statement's `@id` and place. */
function places(result: ReturnType<typeof parsed>) {
  return result.parsed.statements.map(({ id, span }) => [id, placeOf(result.parsed, span)]);
}

describe("parseResolvedPolicy", () => {
  test("places each rule of a policy file at its line there, and no rule that Box adds", () => {
    const result = parsed(RESOLVED, FILES);

    expect(result.failures).toEqual([]);
    expect(places(result)).toEqual([
      ["no_admin", ".box/agent/local/policy.dw:2:1"],
      ["more_rule", ".box/agent/local/sub/more.dw:3:1"],
      ["shell_commands", undefined],
      ["route_github_connect", undefined],
      ["route_github_request", undefined],
    ]);
  });

  test("places a rule with no @id by its text, and each of two rules with one @id at its own line", () => {
    const own =
      `permit (principal, ${HR}, resource) when { context.input.host == "a.example.com" };\n` +
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "a.example.com" };\n` +
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "b.example.com" };\n`;
    const result = parsed(`${own}\n${RESOLVED}`, [
      { file: ".box/agent/local/policy.dw", text: own },
    ]);

    expect(places(result).slice(0, 3)).toEqual([
      ["policy0", ".box/agent/local/policy.dw:1:1"],
      ["dup", ".box/agent/local/policy.dw:2:1"],
      ["dup", ".box/agent/local/policy.dw:3:1"],
    ]);
  });

  test("takes no route from a rule of the profile's own policy files that Box's naming fits", () => {
    const own = `@id("route_mine_connect") permit (principal, ${NC}, resource) when { context.input.host == "x.example.com" && context.input.port == 443 };\n`;

    expect(
      parsed(own, [{ file: ".box/agent/local/policy.dw", text: own }]).parsed.profile.egress,
    ).toEqual({});
  });

  test("fails a syntax error once, at its place in a policy file, or else in Box's policy", () => {
    const broken = `permit (principal, ${HR}, resource) when { context.input.host == };\n`;
    const inFile = parsed(`${broken}\n${RESOLVED}`, [
      { file: ".box/agent/local/policy.dw", text: broken },
    ]);
    const inBox = parsed(`${RESOLVED}${broken}`, FILES);

    expect(inFile.failures).toEqual([
      {
        code: "PARSE_ERROR",
        reason: "Syntax error: unexpected } in a condition. Correct the rule at this place.",
        place: `.box/agent/local/policy.dw:1:${broken.indexOf("}") + 1}`,
      },
    ]);
    expect(inBox.failures).toEqual([
      {
        code: "PARSE_ERROR",
        reason:
          "Build cannot read a rule that Box or a pack adds to this profile (syntax error: " +
          "unexpected } in a condition). Update the AgentCore CLI, then retry.",
        place: ".box/agent/local/profile.toml",
      },
    ]);
  });
});
