import { describe, expect, test } from "bun:test";
import {
  boxGeneratedNetworkRules,
  joinPolicyText,
  placeOfSpan,
  parseProfile,
} from "./profileParser";

function read(text: string) {
  const result = parseProfile(text);
  if (result.failures.length > 0) throw new Error(JSON.stringify(result.failures));
  return result.profile;
}

const refusal = (text: string) => parseProfile(text).failures;

describe("parseProfile", () => {
  test("merges the box/bedrock route under the profile's own [egress.bedrock]", () => {
    const profile = read(
      'packs = ["box/base", "box/bedrock"]\n[options]\nbedrock.region = "eu-west-1"\n' +
        '[egress.bedrock]\nsecret.ref = "aws://default"\n',
    );
    expect(profile.egress).toEqual({
      bedrock: {
        destinations: ["bedrock-runtime.eu-west-1.amazonaws.com"],
        secret: { ref: "aws://default" },
      },
    });
  });

  test("reads the region of a quoted dotted option key, as Box does", () => {
    expect(
      read('packs = ["box/bedrock"]\noptions = { "bedrock.region" = "ap-south-1" }\n').egress,
    ).toEqual({
      bedrock: {
        destinations: ["bedrock-runtime.ap-south-1.amazonaws.com"],
        secret: { ref: "env://AWS_BEARER_TOKEN_BEDROCK" },
      },
    });
  });

  test("uses box/bedrock's default region, and its own secret when the profile sets none", () => {
    expect(read('packs = ["box/bedrock"]\n').egress).toEqual({
      bedrock: {
        destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
        secret: { ref: "env://AWS_BEARER_TOKEN_BEDROCK" },
      },
    });
  });

  test("fails each pack it does not read, at the line of `packs`", () => {
    expect(refusal('# a pack list\npacks = ["box/base", "box/uv", "team/tools"]\n')).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_PACK",
        place: ".box/profile.toml:2",
        reason: expect.stringContaining("box/uv"),
      }),
      expect.objectContaining({
        code: "UNSUPPORTED_PACK",
        place: ".box/profile.toml:2",
        reason: expect.stringContaining("team/tools"),
      }),
    ]);
  });

  test("reads the policy files of `policies`, inside the profile's folder", () => {
    expect(read('policies = ["a.dw", "./rules/b.dw"]\n').policyFiles).toEqual([
      "a.dw",
      "rules/b.dw",
    ]);
    expect(read("[agent]\n").policyFiles).toEqual([]);
  });

  test("refuses `policy`, which the box CLI refuses, and names `policies`", () => {
    expect(refusal('\npolicy = "policy.dw"\n')).toEqual([
      {
        code: "UNSUPPORTED_POLICY_KEY",
        reason:
          "the profile names `policy`, which the box CLI refuses; list the files under `policies`",
        place: ".box/profile.toml:2",
      },
    ]);
  });

  test.each([
    ['policies = ["../escape.dw"]', "outside the profile's folder"],
    ['policies = ["/etc/policy.dw"]', "outside the profile's folder"],
    ['policies = ["a.dw", "./a.dw"]', "twice"],
    ['policies = [""]', "nonempty paths"],
    ['packs = "box/base"', "`packs` is not a list"],
    ["egress = 3", "`egress` is not a table"],
  ])("refuses %s", (text, reason) => {
    expect(refusal(text)[0]).toMatchObject({
      code: "INVALID_PROFILE",
      reason: expect.stringContaining(reason),
    });
  });

  test("places a TOML syntax error at its line and column", () => {
    expect(refusal("a = 1\n[egress\n")).toEqual([
      expect.objectContaining({ code: "INVALID_PROFILE", place: ".box/profile.toml:2:8" }),
    ]);
  });
});

describe("boxGeneratedNetworkRules", () => {
  test("permits each route's and each HTTP MCP server's destinations, as the box CLI does", () => {
    const rules = boxGeneratedNetworkRules(
      {
        github: { destinations: ["api.github.com"] },
        internal: { destinations: ["tools.example.com:8443/v1", "*.svc.example.com"] },
        broken: { destinations: ["https://x.example.com"] },
      },
      {
        search: { type: "http", destinations: ["mcp.search.example"] },
        local: { type: "stdio", command: ["server"] },
      },
    );
    const HR = 'action == Box::Action::"http:request"';
    const NC = 'action == Box::Action::"net:connect"';

    expect(rules.split("\n").filter((line) => !line.includes("metadata_"))).toEqual([
      `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };`,
      `@id("route_github_request") permit (principal, ${HR}, resource) when { context.input.host == "api.github.com" };`,
      `@id("route_internal_connect") permit (principal, ${NC}, resource) when { (context.input.host == "tools.example.com" && context.input.port == 8443) || (context.input.host like "*.svc.example.com" && context.input.port == 443) };`,
      `@id("route_internal_request") permit (principal, ${HR}, resource) when { context.input.host == "tools.example.com" || context.input.host like "*.svc.example.com" };`,
      `@id("mcp_search_connect") permit (principal, ${NC}, resource) when { (context.input.host == "mcp.search.example" && context.input.port == 443) };`,
      `@id("mcp_search_request") permit (principal, ${HR}, resource) when { context.input.host == "mcp.search.example" };`,
      "",
    ]);
    expect(rules).toContain('@id("metadata_hosts") forbid');
    expect(rules).toContain('@id("metadata_addresses") forbid');
  });
});

describe("joinPolicyText", () => {
  test("maps a line of the joined text back to its file, and past the files to none", () => {
    const joined = joinPolicyText(
      [
        { file: ".box/a.dw", text: "// a\npermit (principal, action, resource);" },
        { file: ".box/b.dw", text: "\n\nforbid (principal, action, resource);\n" },
      ],
      '@id("generated") permit (principal, action, resource);\n',
    );

    expect(placeOfSpan(joined.segments, { line: 2, column: 1 })).toBe(".box/a.dw:2:1");
    expect(placeOfSpan(joined.segments, { line: 5, column: 3 })).toBe(".box/b.dw:3:3");
    expect(placeOfSpan(joined.segments, { line: 6, column: 1 })).toBeUndefined();
    expect(joined.text.split("\n")[5]).toBe(
      '@id("generated") permit (principal, action, resource);',
    );
  });
});
