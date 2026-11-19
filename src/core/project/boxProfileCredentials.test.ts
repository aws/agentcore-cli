import { describe, expect, test } from "bun:test";
import { boxCredentialSeedEntries, planBoxProfileCredentials } from "./boxProfileCredentials";
import type { BoxEnvRoute } from "./boxProfileEgress";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";

function spec(credentials: ProjectSpec["credentials"] = []): ProjectSpec {
  return { credentials } as unknown as ProjectSpec;
}

const route = (name: string, variable: string): BoxEnvRoute => ({ route: name, variable });

describe("planBoxProfileCredentials", () => {
  test("adds an ApiKeyCredentialProvider and a seed for each env:// route", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [
      route("github", "GITHUB_TOKEN"),
      route("stripe", "STRIPE_KEY"),
    ]);

    expect(s.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
      { authorizerType: "ApiKeyCredentialProvider", name: "stripe" },
    ]);
    expect(plan.added).toEqual(s.credentials);
    expect(plan.seeds).toEqual([
      { route: "github", variable: "GITHUB_TOKEN", credential: "github" },
      { route: "stripe", variable: "STRIPE_KEY", credential: "stripe" },
    ]);
    expect(plan.messages).toHaveLength(2);
  });

  test("is idempotent: a second pass adds nothing, but still seeds the route", () => {
    const s = spec();
    planBoxProfileCredentials(s, [route("github", "GITHUB_TOKEN")]);

    const again = planBoxProfileCredentials(s, [route("github", "GITHUB_TOKEN")]);

    expect(again.added).toEqual([]);
    expect(again.messages).toEqual([]);
    expect(again.seeds).toEqual([
      { route: "github", variable: "GITHUB_TOKEN", credential: "github" },
    ]);
    expect(s.credentials).toHaveLength(1);
  });

  test("skips the model-provider routes create writes, by name and by provider variable", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [
      route("openai", "OPENAI_API_KEY"),
      route("anthropic", "SOMETHING_ELSE"),
      route("my-llm", "GEMINI_API_KEY"),
      route("openai-compatible", "LLM_KEY"),
    ]);

    expect(plan).toEqual({ messages: [], added: [], seeds: [] });
    expect(s.credentials).toEqual([]);
  });

  test("skips, with no seed, a route whose variable an API key credential already reserves", () => {
    const s = spec([{ authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" }]);

    const plan = planBoxProfileCredentials(s, [
      route("llm", credentialEnvVarName("agentOpenAIApiKey")),
    ]);

    expect(plan).toEqual({ messages: [], added: [], seeds: [] });
  });

  test("reports, but does not add, a name that is not a valid credential name", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [route("bad name!", "SOME_KEY")]);

    expect(plan.added).toEqual([]);
    expect(plan.seeds).toEqual([]);
    expect(plan.messages).toEqual([
      "skipping box egress 'bad name!' (env://SOME_KEY): 'bad name!' is not a valid credential name",
    ]);
  });

  test("reports, but does not add, a name that ends in a credential field suffix", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [route("github_client_id", "GITHUB_ID")]);

    expect(plan.added).toEqual([]);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toContain("ends in '_CLIENT_ID'");
  });

  test("reports, but does not add, a name that derives an existing credential's variable", () => {
    const s = spec([{ authorizerType: "ApiKeyCredentialProvider", name: "git-hub" }]);

    const plan = planBoxProfileCredentials(s, [route("git_hub", "GITHUB_TOKEN")]);

    expect(plan.added).toEqual([]);
    expect(plan.seeds).toEqual([]);
    expect(plan.messages).toEqual([
      "skipping box egress 'git_hub' (env://GITHUB_TOKEN): credential 'git_hub' would derive the " +
        "same variable, AGENTCORE_CREDENTIAL_GIT_HUB, as credential 'git-hub'",
    ]);
    expect(s.credentials).toHaveLength(1);
  });

  test("reports two routes in one profile that derive the same variable, and adds the first", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [
      route("git-hub", "GITHUB_TOKEN"),
      route("git_hub", "GITHUB_TOKEN"),
    ]);

    expect(plan.added.map(({ name }) => name)).toEqual(["git-hub"]);
    expect(plan.messages[1]).toContain("as credential 'git-hub'");
  });

  test("reports, but does not seed, a route named for a credential that is not an API key", () => {
    const s = spec([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        discoveryUrl: "https://example.com/.well-known/openid-configuration",
      },
    ] as unknown as ProjectSpec["credentials"]);

    const plan = planBoxProfileCredentials(s, [route("github", "GITHUB_TOKEN")]);

    expect(plan.added).toEqual([]);
    expect(plan.seeds).toEqual([]);
    expect(plan.messages).toEqual([
      "skipping box egress 'github' (env://GITHUB_TOKEN): credential 'github' is a " +
        "OAuthCredentialProvider credential, not an API key",
    ]);
  });
});

describe("boxCredentialSeedEntries", () => {
  const seed = { route: "github", variable: "GITHUB_TOKEN", credential: "github" };
  const reserved = credentialEnvVarName("github");

  test("carries the key from the environment under the credential's reserved variable", () => {
    const { entries, missing } = boxCredentialSeedEntries([seed], { GITHUB_TOKEN: "ghp_x" }, {});

    expect(entries).toEqual([
      {
        key: reserved,
        value: "ghp_x",
        comment:
          "API key for box egress 'env://GITHUB_TOKEN', provisioned to AgentCore Identity on deploy",
      },
    ]);
    expect(missing).toEqual([]);
  });

  test("falls back to the key agentcore dev stored in .env.local under the box variable", () => {
    const { entries } = boxCredentialSeedEntries([seed], {}, { GITHUB_TOKEN: "ghp_stored" });

    expect(entries.map(({ key, value }) => [key, value])).toEqual([[reserved, "ghp_stored"]]);
  });

  test("prefers the environment over .env.local", () => {
    const { entries } = boxCredentialSeedEntries(
      [seed],
      { GITHUB_TOKEN: "ghp_shell" },
      { GITHUB_TOKEN: "ghp_stored" },
    );

    expect(entries[0]?.value).toBe("ghp_shell");
  });

  test("writes nothing when the reserved variable is already set in either place", () => {
    const env = { GITHUB_TOKEN: "ghp_x" };
    expect(boxCredentialSeedEntries([seed], { ...env, [reserved]: "k" }, {})).toEqual({
      entries: [],
      missing: [],
    });
    expect(boxCredentialSeedEntries([seed], env, { [reserved]: "k" })).toEqual({
      entries: [],
      missing: [],
    });
  });

  test("reports a seed whose key is unset or blank in both places", () => {
    const { entries, missing } = boxCredentialSeedEntries(
      [seed],
      { GITHUB_TOKEN: "  " },
      { GITHUB_TOKEN: "" },
    );

    expect(entries).toEqual([]);
    expect(missing).toEqual([seed]);
  });
});
