import { describe, expect, test } from "bun:test";
import { BOX_RULE_PLACE, parseResolvedPolicy, placeOf, type PolicyFileText } from "./policyParser";

const NC = 'action == Box::Action::"net:connect"';
const HR = 'action == Box::Action::"http:request"';
const NO_ADMIN = `@id("no_admin") forbid (principal, ${HR}, resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };`;
const MORE = `@id("more_rule") forbid (principal, ${HR}, resource) when { context.input.host == "example.com" };`;

/** Box's policy as box 0.1.11 prints it for two policy files and the route `github`. */
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
  { file: ".box/policy.dw", text: `// No admin paths on GitHub.\n${NO_ADMIN}\n` },
  { file: ".box/sub/more.dw", text: `// more\n\n${MORE}\n` },
];
const NO_ROUTES = { egress: {}, mcp: {}, policyFiles: ["policy.dw", "sub/more.dw"] };

function parsed(policy: string, files: PolicyFileText[], egress: Record<string, unknown> = {}) {
  return parseResolvedPolicy({ ...NO_ROUTES, egress }, policy, files);
}

/** Each statement's `@id` and place. */
function places(result: ReturnType<typeof parsed>) {
  return result.parsed.statements.map(({ id, span }) => [id, placeOf(result.parsed, span)]);
}

describe("parseResolvedPolicy", () => {
  test("places each rule of a policy file at its line there, and each other rule as Box's", () => {
    const result = parsed(RESOLVED, FILES);

    expect(result.failures).toEqual([]);
    expect(places(result)).toEqual([
      ["no_admin", ".box/policy.dw:2:1"],
      ["more_rule", ".box/sub/more.dw:3:1"],
      ["shell_commands", BOX_RULE_PLACE],
      ["route_github_connect", BOX_RULE_PLACE],
      ["route_github_request", BOX_RULE_PLACE],
    ]);
  });

  test("places a rule with no @id by its text, and each of two rules with one @id at its own line", () => {
    const own =
      `permit (principal, ${HR}, resource) when { context.input.host == "a.example.com" };\n` +
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "a.example.com" };\n` +
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "b.example.com" };\n`;
    const result = parsed(`${own}\n${RESOLVED}`, [{ file: ".box/policy.dw", text: own }]);

    expect(places(result).slice(0, 3)).toEqual([
      ["policy0", ".box/policy.dw:1:1"],
      ["dup", ".box/policy.dw:2:1"],
      ["dup", ".box/policy.dw:3:1"],
    ]);
  });

  test("takes each route that Box writes only as rules into [egress], after box.toml's routes", () => {
    // `box profile show --full` for [egress.multi], [egress.my-api], and [egress."dot.name"] with
    // no secret: Box sorts the routes by name and leaves them out of box.toml.
    const policy = [
      `@id("route_bedrock_connect") permit (principal, ${NC}, resource) when { (context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" && context.input.port == 443) };`,
      `@id("route_dot.name_connect") permit (principal, ${NC}, resource) when { (context.input.host == "e.example.com" && context.input.port == 443) };`,
      `@id("route_multi_connect") permit (principal, ${NC}, resource) when { (context.input.host == "a.example.com" && context.input.port == 443) || (context.input.host == "b.example.com" && context.input.port == 8443) };`,
      `@id("route_multi_request") permit (principal, ${HR}, resource) when { context.input.host == "a.example.com" || context.input.host == "b.example.com" };`,
      `@id("route_my-api_connect") permit (principal, ${NC}, resource) when { (context.input.host == "d.example.com" && context.input.port == 443) };`,
    ].join("\n");
    const bedrock = {
      destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
      secret: { ref: "aws://default" },
    };

    expect(parsed(policy, [], { bedrock }).parsed.profile.egress).toEqual({
      bedrock,
      "dot.name": { destinations: ["e.example.com"] },
      multi: { destinations: ["a.example.com", "b.example.com:8443"] },
      "my-api": { destinations: ["d.example.com"] },
    });
  });

  test("takes no route from a rule of the profile's own policy files that Box's naming fits", () => {
    const own = `@id("route_mine_connect") permit (principal, ${NC}, resource) when { context.input.host == "x.example.com" && context.input.port == 443 };\n`;

    expect(parsed(own, [{ file: ".box/policy.dw", text: own }]).parsed.profile.egress).toEqual({});
  });

  test("fails a syntax error once, at its place in a policy file, or else in Box's policy", () => {
    const broken = `permit (principal, ${HR}, resource) when { context.input.host == };\n`;
    const inFile = parsed(`${broken}\n${RESOLVED}`, [{ file: ".box/policy.dw", text: broken }]);
    const inBox = parsed(`${RESOLVED}${broken}`, FILES);

    expect(inFile.failures).toEqual([
      {
        code: "PARSE_ERROR",
        reason: "unexpected } in a condition",
        place: `.box/policy.dw:1:${broken.indexOf("}") + 1}`,
      },
    ]);
    expect(inBox.failures).toEqual([
      { code: "PARSE_ERROR", reason: "unexpected } in a condition", place: BOX_RULE_PLACE },
    ]);
  });
});
