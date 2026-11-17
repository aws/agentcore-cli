import { describe, expect, test } from "bun:test";
import { parseResolvedProfile, profilePlaces, profilePolicyFiles } from "./profileParser";

describe("parseResolvedProfile", () => {
  test("reads [egress] and [mcp] of Box's resolved box.toml, and keeps the profile's policy files", () => {
    const { profile, failures } = parseResolvedProfile(
      {
        name: "demo-preview",
        egress: {
          bedrock: {
            destinations: ["bedrock-runtime.eu-west-1.amazonaws.com"],
            secret: { ref: "aws://default" },
          },
        },
        mcp: { docs: { destinations: ["docs.example.com"], type: "http" } },
      },
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
    [
      { egress: 3 },
      "Box resolves `egress` in this profile to a value that is not a table. Write each entry " +
        "as a table, such as [egress.github].",
    ],
    [
      { mcp: ["docs"] },
      "Box resolves `mcp` in this profile to a value that is not a table. Write each entry " +
        "as a table, such as [mcp.github].",
    ],
  ])("fails a box.toml it cannot read, at the profile: %j", (table, reason) => {
    expect(parseResolvedProfile(table, []).failures).toEqual([
      { code: "INVALID_PROFILE", reason, place: ".box/profile.toml" },
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
    [
      'policies = ["../escape.dw"]',
      '`policies` names "../escape.dw", which is outside .box/. Move the file into .box/, and ' +
        "name it from there.",
    ],
    [
      'policies = ["/etc/policy.dw"]',
      '`policies` names "/etc/policy.dw", which is outside .box/. Move the file into .box/, and ' +
        "name it from there.",
    ],
    ['policies = ["a.dw", "./a.dw"]', '`policies` names "./a.dw" twice. Remove one of them.'],
    [
      'policies = [""]',
      '`policies` must be a list of policy file paths, such as ["policy.dw"]. Correct it.',
    ],
  ])("refuses %s at the line of `policies`", (text, reason) => {
    expect(refusal(`# policy files\n  ${text}\n`)).toEqual({
      code: "INVALID_PROFILE",
      reason,
      place: ".box/profile.toml:2:3",
    });
  });

  test("refuses `policy`, which box refuses, at its line, as `agentcore dev` runs no box", () => {
    expect(refusal('\npolicy = "policy.dw"\n')).toEqual({
      code: "UNSUPPORTED_POLICY_KEY",
      reason:
        "Box does not take the key `policy`. List your policy files under `policies` instead, " +
        'such as policies = ["policy.dw"].',
      place: ".box/profile.toml:2:1",
    });
  });

  test("places a TOML syntax error at its line and column", () => {
    expect(refusal("a = 1\n[egress\n")).toEqual({
      code: "INVALID_PROFILE",
      reason: "This is not valid TOML (illegal character in key). Correct the syntax.",
      place: ".box/profile.toml:2:8",
    });
  });
});

describe("profilePlaces", () => {
  test("places each entry by its header, its dotted key, or its key under [egress]", () => {
    const places = profilePlaces(
      [
        'packs = ["box/base", "box/bedrock"]',
        'policies = ["policy.dw"]',
        "",
        "[egress.github]",
        'destinations = ["api.github.com"]',
        "",
        '[egress."dot.name".secret]',
        'ref = "env://KEY"',
        "",
        "[egress]",
        '  inline = { destinations = ["a.example.com"] }',
        "",
        "[agent]",
        'command = ["python", "--host=1"]',
        'mcp.docs = { type = "http" }',
        "",
        "[mcp.tools]",
        'type = "stdio"',
      ].join("\n"),
    );

    expect(Object.fromEntries(places.entries)).toEqual({
      "egress.github": ".box/profile.toml:4:1",
      "egress.dot.name": ".box/profile.toml:7:1",
      "egress.inline": ".box/profile.toml:11:3",
      "mcp.tools": ".box/profile.toml:17:1",
    });
    expect(places.packs).toBe(".box/profile.toml:1:1");
    expect(places.policies).toBe(".box/profile.toml:2:1");
  });

  test("places no entry, `packs`, or `policies` that the profile does not set", () => {
    expect(profilePlaces('[agent]\ncommand = ["/bin/sh"]\n')).toEqual({ entries: new Map() });
  });
});
