import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBoxProfileCredentials, boxProfileCredentialEnvEntries } from "./boxProfileCredentials";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function projectWithProfile(toml: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-profile-creds-"));
  directories.push(root);
  if (toml !== undefined) {
    await mkdir(join(root, ".box"), { recursive: true });
    await writeFile(join(root, ".box", "profile.toml"), toml);
  }
  return root;
}

function spec(credentials: ProjectSpec["credentials"] = []): ProjectSpec {
  return { credentials } as unknown as ProjectSpec;
}

describe("addBoxProfileCredentials", () => {
  test("adds an ApiKeyCredentialProvider and records the source var for each env:// secret", async () => {
    const root = await projectWithProfile(
      '[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n\n' +
        '[egress.stripe]\nsecret.ref = "env://STRIPE_KEY"\n',
    );
    const s = spec();

    const { messages, added } = addBoxProfileCredentials(s, root);

    expect(s.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
      { authorizerType: "ApiKeyCredentialProvider", name: "stripe" },
    ]);
    expect(added).toEqual([
      { name: "github", variable: "GITHUB_TOKEN" },
      { name: "stripe", variable: "STRIPE_KEY" },
    ]);
    expect(messages).toHaveLength(2);
  });

  test("skips aws:// and other non-env refs", async () => {
    const root = await projectWithProfile('[egress.bedrock]\nsecret.ref = "aws://default"\n');
    const s = spec();

    expect(addBoxProfileCredentials(s, root)).toEqual({ messages: [], added: [] });
    expect(s.credentials).toEqual([]);
  });

  test("skips a var an existing credential already covers (the model provider key)", async () => {
    const covered = credentialEnvVarName("agentOpenAIApiKey");
    const root = await projectWithProfile(`[egress.openai]\nsecret.ref = "env://${covered}"\n`);
    const s = spec([{ authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" }]);

    expect(addBoxProfileCredentials(s, root)).toEqual({ messages: [], added: [] });
    expect(s.credentials).toHaveLength(1);
  });

  test("is idempotent: a second pass adds nothing", async () => {
    const root = await projectWithProfile('[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n');
    const s = spec();

    addBoxProfileCredentials(s, root);
    expect(addBoxProfileCredentials(s, root)).toEqual({ messages: [], added: [] });
    expect(s.credentials).toHaveLength(1);
  });

  test("reports, but does not add, an egress name that is not a valid credential name", async () => {
    const root = await projectWithProfile('[egress.ab]\nsecret.ref = "env://AB_KEY"\n');
    const s = spec();

    const { messages, added } = addBoxProfileCredentials(s, root);

    expect(s.credentials).toEqual([]);
    expect(added).toEqual([]);
    expect(messages[0]).toContain("not a valid credential name");
  });

  test("is a no-op when the project has no box profile", async () => {
    const root = await projectWithProfile(undefined);
    const s = spec();

    expect(addBoxProfileCredentials(s, root)).toEqual({ messages: [], added: [] });
    expect(s.credentials).toEqual([]);
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
