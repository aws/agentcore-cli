import { describe, expect, test } from "bun:test";
import { parseResolvedProfile, profilePolicyFiles } from "./profileParser";

describe("parseResolvedProfile", () => {
  test("reads [egress] and [mcp] of Box's resolved box.toml, and keeps the profile's policy files", () => {
    const { profile, failures } = parseResolvedProfile(
      'name = "demo-preview"\n\n[egress.bedrock]\ndestinations = ["bedrock-runtime.eu-west-1.amazonaws.com"]\n\n' +
        '[egress.bedrock.secret]\nref = "aws://default"\n\n[mcp.docs]\ndestinations = ["docs.example.com"]\ntype = "http"\n',
      ["policy.dw"],
    );

    expect(failures).toEqual([]);
    expect(profile).toEqual({
      egress: {
        bedrock: {
          destinations: ["bedrock-runtime.eu-west-1.amazonaws.com"],
          secret: { ref: "aws://default" },
        },
      },
      mcp: { docs: { destinations: ["docs.example.com"], type: "http" } },
      policyFiles: ["policy.dw"],
    });
  });

  test.each([
    ["egress = 3", "`egress` is not a table"],
    ["[egress", "Invalid"],
  ])("fails a box.toml it cannot read: %s", (text, reason) => {
    expect(parseResolvedProfile(text, []).failures).toEqual([
      {
        code: "INVALID_PROFILE",
        reason: expect.stringContaining(reason),
        place: "the box.toml of `box profile show`",
      },
    ]);
  });
});

describe("profilePolicyFiles", () => {
  const files = (text: string) => {
    const result = profilePolicyFiles(text);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    return result.files;
  };
  const refusal = (text: string) => {
    const result = profilePolicyFiles(text);
    return result.ok ? undefined : result.failure;
  };

  test("reads the policy files of `policies`, inside the profile's folder", () => {
    expect(files('policies = ["a.dw", "./rules/b.dw"]\n')).toEqual(["a.dw", "rules/b.dw"]);
    expect(files("[agent]\n")).toEqual([]);
  });

  test.each([
    ['policies = ["../escape.dw"]', "outside the profile's folder"],
    ['policies = ["/etc/policy.dw"]', "outside the profile's folder"],
    ['policies = ["a.dw", "./a.dw"]', "twice"],
    ['policies = [""]', "nonempty paths"],
  ])("refuses %s at the line of `policies`", (text, reason) => {
    expect(refusal(`# policy files\n${text}\n`)).toEqual({
      code: "INVALID_PROFILE",
      reason: expect.stringContaining(reason),
      place: ".box/profile.toml:2",
    });
  });

  test("refuses `policy`, which box refuses, at its line, as `agentcore dev` runs no box", () => {
    expect(refusal('\npolicy = "policy.dw"\n')).toEqual({
      code: "UNSUPPORTED_POLICY_KEY",
      reason:
        "the profile names `policy`, which the box CLI refuses; list the files under `policies`",
      place: ".box/profile.toml:2",
    });
  });

  test("places a TOML syntax error at its line and column", () => {
    expect(refusal("a = 1\n[egress\n")).toMatchObject({
      code: "INVALID_PROFILE",
      place: ".box/profile.toml:2:8",
    });
  });
});
