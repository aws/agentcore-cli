import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvLocalFile } from "../project/envLocal";
import { boxDevSecrets, missingBoxSecretWarning } from "./boxDevSecrets";

const GITHUB_ROUTE =
  '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
const TOOLS_SERVER =
  '[mcp.tools]\ntype = "http"\nurl = "https://tools.example.com/mcp"\nsecret.ref = "env://TOOLS_TOKEN"\n';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(profile?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-box-dev-secrets-"));
  roots.push(root);
  await mkdir(join(root, "agentcore"));
  if (profile !== undefined) {
    await mkdir(join(root, ".box"));
    await writeFile(join(root, ".box", "profile.toml"), profile);
  }
  return root;
}

describe("boxDevSecrets", () => {
  test("returns an env:// route's variable under its own name, and writes no .env.local", async () => {
    const root = await project(GITHUB_ROUTE);

    expect(await boxDevSecrets(root, { GITHUB_TOKEN: "ghp_1", OTHER: "x" })).toEqual({
      env: { GITHUB_TOKEN: "ghp_1" },
      missing: [],
    });
    expect(existsSync(new EnvLocalFile(root).path)).toBe(false);
  });

  test("returns an HTTP MCP server's env:// variable too", async () => {
    const root = await project(GITHUB_ROUTE + TOOLS_SERVER);

    expect(await boxDevSecrets(root, { GITHUB_TOKEN: "ghp_1", TOOLS_TOKEN: "tk_1" })).toEqual({
      env: { GITHUB_TOKEN: "ghp_1", TOOLS_TOKEN: "tk_1" },
      missing: [],
    });
  });

  test("names one variable once when two tables read it", async () => {
    const root = await project(
      GITHUB_ROUTE +
        '[egress.gist]\ndestinations = ["gist.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
    );

    expect(await boxDevSecrets(root, {})).toEqual({
      env: {},
      missing: [{ variable: "GITHUB_TOKEN", table: "[egress.github]" }],
    });
  });

  test("reports a variable that is unset or blank as missing, with the table that reads it", async () => {
    const root = await project(GITHUB_ROUTE + TOOLS_SERVER);

    expect(await boxDevSecrets(root, { GITHUB_TOKEN: "  " })).toEqual({
      env: {},
      missing: [
        { variable: "GITHUB_TOKEN", table: "[egress.github]" },
        { variable: "TOOLS_TOKEN", table: "[mcp.tools]" },
      ],
    });
  });

  test("leaves out a pack's variable and a secret that is not env://", async () => {
    const root = await project(
      'packs = ["box/bedrock"]\n[egress.s3]\ndestinations = ["s3.amazonaws.com"]\nsecret.ref = "aws://default"\n',
    );

    expect(await boxDevSecrets(root, { AWS_BEARER_TOKEN_BEDROCK: "token", default: "x" })).toEqual({
      env: {},
      missing: [],
    });
  });

  test("returns nothing for a profile that does not parse; box run reports it", async () => {
    const root = await project("[egress\n");

    expect(await boxDevSecrets(root, {})).toEqual({ env: {}, missing: [] });
  });

  test("returns nothing without a box profile", async () => {
    const root = await project();

    expect(await boxDevSecrets(root, { GITHUB_TOKEN: "ghp_1" })).toEqual({
      env: {},
      missing: [],
    });
  });
});

describe("missingBoxSecretWarning", () => {
  test("names the profile, the variable, its table, and both ways to set it", () => {
    expect(missingBoxSecretWarning({ variable: "GITHUB_TOKEN", table: "[egress.github]" })).toBe(
      "the box profile .box/profile.toml reads GITHUB_TOKEN for [egress.github], but it is not " +
        "set, and box does not start without it. Export it in this shell " +
        "(export GITHUB_TOKEN=...) or put it in agentcore/.env.local, then restart dev.",
    );
  });
});
