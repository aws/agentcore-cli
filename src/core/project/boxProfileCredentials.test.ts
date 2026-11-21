import { describe, expect, test } from "bun:test";
import {
  boxKeyVariables,
  planBoxProfileCredentials,
  type BoxKeySources,
} from "./boxProfileCredentials";
import type { BoxEnvRoute } from "./boxProfileEgress";
import { ENV_LOCAL_RELATIVE_PATH } from "./envLocal";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import { ProjectSpecSchema, type ProjectSpec } from "../../projectSchemas/project";

/** A project spec with `credentials`, as the schema parses it. */
function spec(credentials: readonly object[] = []): ProjectSpec {
  return ProjectSpecSchema.parse({ name: "example", version: 2, credentials });
}

const route = (name: string, variable: string): BoxEnvRoute => ({ route: name, variable });
const shell = (env: NodeJS.ProcessEnv): BoxKeySources => ({ env, envLocal: {} });
const GITHUB = route("github", "GITHUB_TOKEN");
const RESERVED = credentialEnvVarName("github");
const API_KEY = { authorizerType: "ApiKeyCredentialProvider", name: "github" } as const;

describe("planBoxProfileCredentials", () => {
  test("adds an ApiKeyCredentialProvider and stores its key for each env:// route", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(
      s,
      [GITHUB, route("stripe", "STRIPE_KEY")],
      shell({ GITHUB_TOKEN: "ghp_x", STRIPE_KEY: "sk_x" }),
    );

    expect(s.credentials).toEqual([
      API_KEY,
      { authorizerType: "ApiKeyCredentialProvider", name: "stripe" },
    ]);
    expect(plan.added).toEqual(s.credentials);
    expect(plan.entries).toEqual([
      {
        key: RESERVED,
        value: "ghp_x",
        comment:
          "API key for box egress 'env://GITHUB_TOKEN', provisioned to AgentCore Identity on deploy",
      },
      expect.objectContaining({ key: credentialEnvVarName("stripe"), value: "sk_x" }),
    ]);
    expect(plan.messages).toHaveLength(2);
  });

  test("adds no credential for a route whose key is in neither place, and says what to set", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(s, [GITHUB], shell({ GITHUB_TOKEN: " " }));

    expect(s.credentials).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.entries).toEqual([]);
    expect(plan.warnings).toEqual([
      "not adding credential 'github' for box egress 'env://GITHUB_TOKEN': GITHUB_TOKEN is not set " +
        `here or in ${ENV_LOCAL_RELATIVE_PATH}, so deploy could not provision it. Set GITHUB_TOKEN, or ${RESERVED}, ` +
        "and build again",
    ]);
  });

  test("names the variable once when the route reads its own credential's variable", () => {
    const plan = planBoxProfileCredentials(spec(), [route("github", RESERVED)], shell({}));

    expect(plan.warnings[0]).toEndWith(`Set ${RESERVED} and build again`);
  });

  test("takes the key from .env.local under the box variable when the shell has none", () => {
    const plan = planBoxProfileCredentials(spec(), [GITHUB], {
      env: {},
      envLocal: { GITHUB_TOKEN: "ghp_stored" },
    });

    expect(plan.added).toEqual([API_KEY]);
    expect(plan.entries.map(({ key, value }) => [key, value])).toEqual([[RESERVED, "ghp_stored"]]);
  });

  test("prefers the shell over .env.local", () => {
    const plan = planBoxProfileCredentials(spec(), [GITHUB], {
      env: { GITHUB_TOKEN: "ghp_shell" },
      envLocal: { GITHUB_TOKEN: "ghp_stored" },
    });

    expect(plan.entries[0]?.value).toBe("ghp_shell");
  });

  test("adds the credential with no entry when its reserved variable is already set", () => {
    for (const sources of [
      { env: { [RESERVED]: "k" }, envLocal: {} },
      { env: {}, envLocal: { [RESERVED]: "k" } },
    ]) {
      const plan = planBoxProfileCredentials(spec(), [GITHUB], sources);

      expect(plan.added).toEqual([API_KEY]);
      expect(plan.entries).toEqual([]);
    }
  });

  test("is idempotent: a later build adds nothing, but still stores a key it can find", () => {
    const s = spec([API_KEY]);

    const plan = planBoxProfileCredentials(s, [GITHUB], shell({ GITHUB_TOKEN: "ghp_x" }));

    expect(plan.added).toEqual([]);
    expect(plan.messages).toEqual([]);
    expect(plan.entries.map(({ key }) => key)).toEqual([RESERVED]);
    expect(s.credentials).toEqual([API_KEY]);
  });

  // dev hands box the route's variable, so after a rotation deploy must provision the same key.
  test("replaces a stored key the route's variable no longer holds, and says so", () => {
    const plan = planBoxProfileCredentials(spec([API_KEY]), [GITHUB], {
      env: { GITHUB_TOKEN: "ghp_new" },
      envLocal: { [RESERVED]: "ghp_old" },
    });

    expect(plan.entries.map(({ key, value }) => [key, value])).toEqual([[RESERVED, "ghp_new"]]);
    expect(plan.messages).toEqual([
      `updating ${RESERVED} in ${ENV_LOCAL_RELATIVE_PATH}: GITHUB_TOKEN holds a different key, ` +
        "which agentcore dev uses, so deploy provisions it too",
    ]);
  });

  test("leaves a stored key alone when the variable holds it, or when nothing sets the variable", () => {
    for (const env of [{ GITHUB_TOKEN: "ghp_same" }, {}]) {
      const plan = planBoxProfileCredentials(spec([API_KEY]), [GITHUB], {
        env,
        envLocal: { [RESERVED]: "ghp_same" },
      });

      expect(plan.entries).toEqual([]);
      expect(plan.messages).toEqual([]);
    }
  });

  test("leaves the stored key alone when the shell sets the credential's own variable", () => {
    // Deploy provisions that one, so the route's variable has nothing to change.
    const plan = planBoxProfileCredentials(spec([API_KEY]), [GITHUB], {
      env: { GITHUB_TOKEN: "ghp_new", [RESERVED]: "ghp_explicit" },
      envLocal: { [RESERVED]: "ghp_old" },
    });

    expect(plan.entries).toEqual([]);
  });

  test("keeps an earlier build's credential and says what to set when its key has gone", () => {
    const plan = planBoxProfileCredentials(spec([API_KEY]), [GITHUB], shell({}));

    expect(plan.added).toEqual([]);
    expect(plan.warnings).toEqual([
      "box egress 'github' reads env://GITHUB_TOKEN, which is not set here or in " +
        `${ENV_LOCAL_RELATIVE_PATH}: set GITHUB_TOKEN, or ${RESERVED}, before deploy`,
    ]);
  });

  test("stores nothing for an API key credential that keeps its key in Secrets Manager", () => {
    const s = spec([
      {
        ...API_KEY,
        secretRef: {
          secretId: "arn:aws:secretsmanager:us-west-2:111122223333:secret:gh",
          jsonKey: "token",
        },
      },
    ]);

    expect(planBoxProfileCredentials(s, [GITHUB], shell({ GITHUB_TOKEN: "ghp_x" }))).toEqual({
      messages: [],
      warnings: [],
      added: [],
      entries: [],
    });
  });

  test("skips, with no message, the model-provider routes create writes", () => {
    const s = spec();

    const plan = planBoxProfileCredentials(
      s,
      [route("openai", "OPENAI_API_KEY"), route("anthropic", "ANTHROPIC_API_KEY")],
      shell({ OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-ant-x" }),
    );

    expect(plan).toEqual({ messages: [], warnings: [], added: [], entries: [] });
    expect(s.credentials).toEqual([]);
  });

  test("skips, with no message, a route whose variable an existing credential reserves", () => {
    const s = spec([{ authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" }]);

    const plan = planBoxProfileCredentials(
      s,
      [route("openai", credentialEnvVarName("agentOpenAIApiKey"))],
      shell({}),
    );

    expect(plan).toEqual({ messages: [], warnings: [], added: [], entries: [] });
  });

  test("reports a route that uses a model-provider name or variable in another way", () => {
    const plan = planBoxProfileCredentials(
      spec(),
      [route("openai", "MY_KEY"), route("my-llm", "GEMINI_API_KEY")],
      shell({ MY_KEY: "k", GEMINI_API_KEY: "k" }),
    );

    expect(plan.added).toEqual([]);
    expect(plan.warnings).toEqual([
      "skipping box egress 'openai' (env://MY_KEY): 'openai' is a model-provider route; " +
        "agentcore create declares its key",
      "skipping box egress 'my-llm' (env://GEMINI_API_KEY): GEMINI_API_KEY is a model provider's " +
        "key variable; agentcore create declares its key",
    ]);
  });

  test.each<{
    label: string;
    credentials: object[];
    routes: BoxEnvRoute[];
    added: string[];
    warning: string;
  }>([
    {
      label: "a name that is not a valid credential name",
      credentials: [],
      routes: [route("bad name!", "SOME_KEY")],
      added: [],
      warning:
        "skipping box egress 'bad name!' (env://SOME_KEY): 'bad name!' is not a valid credential name",
    },
    {
      label: "a name that ends in a credential field suffix",
      credentials: [],
      routes: [route("github_client_id", "GITHUB_ID")],
      added: [],
      warning:
        "skipping box egress 'github_client_id' (env://GITHUB_ID): 'github_client_id' ends in " +
        "'_CLIENT_ID', the suffix of a credential field, so its variable " +
        `${credentialEnvVarName("github_client_id")} would read as a field of another credential`,
    },
    {
      label: "a name that derives an existing credential's variable",
      credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "git-hub" }],
      routes: [route("git_hub", "GITHUB_TOKEN")],
      added: [],
      warning:
        "skipping box egress 'git_hub' (env://GITHUB_TOKEN): credential 'git_hub' would derive the " +
        "same variable, AGENTCORE_CREDENTIAL_GIT_HUB, as credential 'git-hub'",
    },
    {
      label: "the second of two routes in one profile that derive the same variable",
      credentials: [],
      routes: [route("git-hub", "GITHUB_TOKEN"), route("git_hub", "GITHUB_TOKEN")],
      added: ["git-hub"],
      warning:
        "skipping box egress 'git_hub' (env://GITHUB_TOKEN): credential 'git_hub' would derive the " +
        "same variable, AGENTCORE_CREDENTIAL_GIT_HUB, as credential 'git-hub'",
    },
    {
      label: "a route named for an OAuth credential",
      credentials: [
        {
          authorizerType: "OAuthCredentialProvider",
          name: "github",
          discoveryUrl: "https://example.com/.well-known/openid-configuration",
        },
      ],
      routes: [GITHUB],
      added: [],
      warning:
        "skipping box egress 'github' (env://GITHUB_TOKEN): credential 'github' is an " +
        "OAuthCredentialProvider credential, not an API key",
    },
    {
      label: "a route named for a payment credential",
      credentials: [
        { authorizerType: "PaymentCredentialProvider", name: "github", provider: "StripePrivy" },
      ],
      routes: [GITHUB],
      added: [],
      warning:
        "skipping box egress 'github' (env://GITHUB_TOKEN): credential 'github' is a " +
        "PaymentCredentialProvider credential, not an API key",
    },
  ])("reports, but does not add, $label", ({ credentials, routes, added, warning }) => {
    const plan = planBoxProfileCredentials(
      spec(credentials),
      routes,
      shell({ SOME_KEY: "k", GITHUB_ID: "k", GITHUB_TOKEN: "k" }),
    );

    expect(plan.added.map(({ name }) => name)).toEqual(added);
    expect(plan.entries.map(({ key }) => key)).toEqual(
      added.map((name) => credentialEnvVarName(name)),
    );
    expect(plan.warnings).toEqual([warning]);
  });
});

describe("boxKeyVariables", () => {
  test("holds the variables of each route the planner looks up a key for", () => {
    expect(boxKeyVariables([], [GITHUB])).toEqual(new Set(["GITHUB_TOKEN", RESERVED]));
  });

  test("skips a model-provider route and a route whose variable a credential reserves", () => {
    const reserved = credentialEnvVarName("agentOpenAIApiKey");

    const variables = boxKeyVariables(
      [{ authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" }],
      [route("openai", "OPENAI_API_KEY"), route("my-llm", reserved)],
    );

    expect(variables).toEqual(new Set());
  });
});
