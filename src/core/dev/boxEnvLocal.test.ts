import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvLocalFile } from "../project/envLocal";
import { writeBoxDevEnvLocal } from "./boxEnvLocal";

const GITHUB_ROUTE =
  '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';

const AGENT = "agent";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(profile?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-box-env-local-"));
  roots.push(root);
  await mkdir(join(root, "agentcore"));
  if (profile !== undefined) {
    const local = join(root, "box", AGENT, "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "profile.toml"), profile);
  }
  return root;
}

const envLocal = (root: string) => new EnvLocalFile(root).read();

describe("writeBoxDevEnvLocal", () => {
  test("writes an env:// route's variable under its own name", async () => {
    const root = await project(GITHUB_ROUTE);

    const messages = await writeBoxDevEnvLocal(root, AGENT, { GITHUB_TOKEN: "ghp_1" });

    expect(await envLocal(root)).toEqual({ GITHUB_TOKEN: "ghp_1" });
    expect(messages).toEqual([
      "writing GITHUB_TOKEN to agentcore/.env.local for box egress 'github' (env://GITHUB_TOKEN)",
    ]);
  });

  test("keeps a value .env.local holds already", async () => {
    const root = await project(GITHUB_ROUTE);
    await new EnvLocalFile(root).insertIfNew([
      { key: "GITHUB_TOKEN", value: "ghp_old", comment: "mine" },
    ]);

    expect(await writeBoxDevEnvLocal(root, AGENT, { GITHUB_TOKEN: "ghp_new" })).toEqual([]);
    expect(await envLocal(root)).toEqual({ GITHUB_TOKEN: "ghp_old" });
  });

  test("writes nothing for a variable that is unset or blank", async () => {
    const root = await project(GITHUB_ROUTE);

    expect(await writeBoxDevEnvLocal(root, AGENT, {})).toEqual([]);
    expect(await writeBoxDevEnvLocal(root, AGENT, { GITHUB_TOKEN: "  " })).toEqual([]);
    expect(existsSync(new EnvLocalFile(root).path)).toBe(false);
  });

  test("does not copy the credential's stored key into the route's variable", async () => {
    const root = await project(GITHUB_ROUTE);
    await new EnvLocalFile(root).insertIfNew([
      { key: "AGENTCORE_CREDENTIAL_GITHUB", value: "ghp_1", comment: "deploy" },
    ]);

    expect(await writeBoxDevEnvLocal(root, AGENT, {})).toEqual([]);
    expect(await envLocal(root)).toEqual({ AGENTCORE_CREDENTIAL_GITHUB: "ghp_1" });
  });

  test("leaves out a pack's variable and a route without an env:// secret", async () => {
    const root = await project(
      'packs = ["box/bedrock"]\n[egress.s3]\ndestinations = ["s3.amazonaws.com"]\nsecret.ref = "aws://default"\n',
    );

    expect(
      await writeBoxDevEnvLocal(root, AGENT, { AWS_BEARER_TOKEN_BEDROCK: "token", default: "x" }),
    ).toEqual([]);
    expect(existsSync(new EnvLocalFile(root).path)).toBe(false);
  });

  test("does nothing without a box profile", async () => {
    const root = await project();

    expect(await writeBoxDevEnvLocal(root, AGENT, { GITHUB_TOKEN: "ghp_1" })).toEqual([]);
    expect(existsSync(new EnvLocalFile(root).path)).toBe(false);
  });
});
