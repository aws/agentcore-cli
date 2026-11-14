import { describe, expect, test } from "bun:test";
import {
  addBoxEgressCredentials,
  boxEgressCredentialName,
  boxEgressCredentials,
  boxProfileCredentialEnvEntries,
} from "./boxProfileCredentials";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";

function spec(credentials: ProjectSpec["credentials"] = []): ProjectSpec {
  return { credentials } as unknown as ProjectSpec;
}

const GITHUB = { github: { secret: { ref: "env://GITHUB_TOKEN" } } };

describe("boxEgressCredentials", () => {
  test("needs an API key credential, named after the entry, for each env:// secret", () => {
    const egress = { ...GITHUB, stripe: { secret: { ref: "env://STRIPE_KEY" } } };

    expect(boxEgressCredentials(egress, [])).toEqual({
      needed: [
        { name: "github", variable: "GITHUB_TOKEN" },
        { name: "stripe", variable: "STRIPE_KEY" },
      ],
      skipped: [],
    });
  });

  test("skips aws:// and other non-env refs", () => {
    expect(boxEgressCredentials({ bedrock: { secret: { ref: "aws://default" } } }, [])).toEqual({
      needed: [],
      skipped: [],
    });
  });

  test("takes the credential that already covers the var (the model provider key)", () => {
    const covered = credentialEnvVarName("agentOpenAIApiKey");
    const credentials = [
      { authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" },
    ] as ProjectSpec["credentials"];

    expect(
      boxEgressCredentials({ openai: { secret: { ref: `env://${covered}` } } }, credentials).needed,
    ).toEqual([{ name: "agentOpenAIApiKey", variable: covered }]);
  });

  test("reports, but needs no credential for, an egress name that is not a credential name", () => {
    const { needed, skipped } = boxEgressCredentials(
      { ab: { secret: { ref: "env://AB_KEY" } } },
      [],
    );

    expect(needed).toEqual([]);
    expect(skipped[0]).toContain("not a valid credential name");
  });

  test("lists a route even after agentcore.json declares its credential, so build seeds it", () => {
    const credentials = [
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
    ] as ProjectSpec["credentials"];

    expect(boxEgressCredentials(GITHUB, credentials).needed).toEqual([
      { name: "github", variable: "GITHUB_TOKEN" },
    ]);
  });
});

describe("boxEgressCredentialName", () => {
  test("names no credential that a credential of another kind holds", () => {
    const credentials = [{ authorizerType: "OAuthCredentialProvider", name: "github" }] as never;

    expect(boxEgressCredentialName(credentials, "github", "GITHUB_TOKEN")).toBeUndefined();
  });
});

describe("addBoxEgressCredentials", () => {
  test("declares each needed credential once, and is idempotent", () => {
    const s = spec();
    const needed = [{ name: "github", variable: "GITHUB_TOKEN" }];

    expect(addBoxEgressCredentials(s, needed)).toEqual([
      "adding API key credential 'github' to agentcore.json for box egress 'env://GITHUB_TOKEN', so deploy provisions it in AgentCore Identity",
    ]);
    expect(addBoxEgressCredentials(s, needed)).toEqual([]);
    expect(s.credentials).toEqual([{ authorizerType: "ApiKeyCredentialProvider", name: "github" }]);
  });
});

describe("boxProfileCredentialEnvEntries", () => {
  const added = [{ name: "github", variable: "GITHUB_TOKEN" }];

  test("carries a set var into .env.local under the credential's reserved name", () => {
    const entries = boxProfileCredentialEnvEntries(added, { GITHUB_TOKEN: "ghp_123" });

    expect(entries).toEqual([
      {
        key: credentialEnvVarName("github"),
        value: "ghp_123",
        comment: expect.stringContaining("env://GITHUB_TOKEN"),
      },
    ]);
  });

  test("skips a var that is unset or empty, leaving it for the operator", () => {
    expect(boxProfileCredentialEnvEntries(added, {})).toEqual([]);
    expect(boxProfileCredentialEnvEntries(added, { GITHUB_TOKEN: "" })).toEqual([]);
  });
});
