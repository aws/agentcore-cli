import { describe, expect, test } from "bun:test";
import { ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";
import { boxDevSecrets, missingBoxSecretWarning, shadowedBoxSecretNote } from "./boxDevSecrets";

const GITHUB_ROUTE =
  '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
const TOOLS_SERVER =
  '[mcp.tools]\ntype = "http"\nurl = "https://tools.example.com/mcp"\nsecret.ref = "env://TOOLS_TOKEN"\n';

/** The secrets of `profile` when only the shell sets the variables. */
const fromShell = (profile: string, env: NodeJS.ProcessEnv) =>
  boxDevSecrets(profile, { env, envLocal: {} });

describe("boxDevSecrets", () => {
  test("returns an env:// route's variable under its own name", () => {
    expect(fromShell(GITHUB_ROUTE, { GITHUB_TOKEN: "ghp_1", OTHER: "x" })).toEqual({
      env: { GITHUB_TOKEN: "ghp_1" },
      missing: [],
      shadowed: [],
    });
  });

  test("returns an HTTP MCP server's env:// variable too", () => {
    expect(
      fromShell(GITHUB_ROUTE + TOOLS_SERVER, { GITHUB_TOKEN: "ghp_1", TOOLS_TOKEN: "tk_1" }).env,
    ).toEqual({ GITHUB_TOKEN: "ghp_1", TOOLS_TOKEN: "tk_1" });
  });

  test("names one variable once when two tables read it", () => {
    const profile =
      GITHUB_ROUTE +
      '[egress.gist]\ndestinations = ["gist.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
    expect(fromShell(profile, {}).missing).toEqual([
      { variable: "GITHUB_TOKEN", table: "[egress.github]" },
    ]);
  });

  test("reports a variable that is unset or blank as missing, with the table that reads it", () => {
    expect(fromShell(GITHUB_ROUTE + TOOLS_SERVER, { GITHUB_TOKEN: "  " })).toEqual({
      env: {},
      missing: [
        { variable: "GITHUB_TOKEN", table: "[egress.github]" },
        { variable: "TOOLS_TOKEN", table: "[mcp.tools]" },
      ],
      shadowed: [],
    });
  });

  test("leaves out a pack's variable, a secret that is not env://, and a blank name", () => {
    const profile =
      'packs = ["box/bedrock"]\n[egress.s3]\ndestinations = ["s3.amazonaws.com"]\nsecret.ref = "aws://default"\n' +
      '[egress.blank]\ndestinations = ["blank.example.com"]\nsecret.ref = "env://  "\n';
    expect(fromShell(profile, { AWS_BEARER_TOKEN_BEDROCK: "token", default: "x" })).toEqual({
      env: {},
      missing: [],
      shadowed: [],
    });
  });

  test("returns nothing for a profile that does not parse; box run reports it", () => {
    expect(fromShell("[egress\n", {})).toEqual({ env: {}, missing: [], shadowed: [] });
  });
});

describe("boxDevSecrets picks each variable as build does", () => {
  test("takes a set shell value over .env.local's, and notes that the two differ", () => {
    expect(
      boxDevSecrets(GITHUB_ROUTE, {
        env: { GITHUB_TOKEN: "ghp_shell" },
        envLocal: { GITHUB_TOKEN: "ghp_file" },
      }),
    ).toEqual({
      env: { GITHUB_TOKEN: "ghp_shell" },
      missing: [],
      shadowed: [{ variable: "GITHUB_TOKEN", table: "[egress.github]" }],
    });
  });

  test("notes nothing when the shell and .env.local hold the same key", () => {
    const secrets = boxDevSecrets(GITHUB_ROUTE, {
      env: { GITHUB_TOKEN: "ghp_same" },
      envLocal: { GITHUB_TOKEN: "ghp_same" },
    });
    expect(secrets.shadowed).toEqual([]);
  });

  test("takes .env.local's value when the shell's is blank, as box then gets it", () => {
    // A blank shell value, such as an unset CI secret, must not hide the .env.local one: box
    // starts with the .env.local key, so dev must not warn that it is missing.
    for (const env of [{ GITHUB_TOKEN: "" }, { GITHUB_TOKEN: "  " }, {}]) {
      expect(boxDevSecrets(GITHUB_ROUTE, { env, envLocal: { GITHUB_TOKEN: "ghp_file" } })).toEqual({
        env: { GITHUB_TOKEN: "ghp_file" },
        missing: [],
        shadowed: [],
      });
    }
  });

  // process.env is case-insensitive on Windows; a copy of it is not, so the name is matched here.
  test("finds the shell's variable in any case on Windows, under the profile's name", () => {
    const sources = { env: { Github_Token: "ghp_win" }, envLocal: {} };
    expect(boxDevSecrets(GITHUB_ROUTE, sources, "win32").env).toEqual({ GITHUB_TOKEN: "ghp_win" });
    expect(boxDevSecrets(GITHUB_ROUTE, sources, "linux").missing).toEqual([
      { variable: "GITHUB_TOKEN", table: "[egress.github]" },
    ]);
  });
});

describe("missingBoxSecretWarning", () => {
  test("names the profile, the variable, its table, and both ways to set it", () => {
    expect(missingBoxSecretWarning({ variable: "GITHUB_TOKEN", table: "[egress.github]" })).toBe(
      "the box profile .box/profile.toml reads GITHUB_TOKEN for [egress.github], but it is not " +
        "set, and box does not start without it. Export it in this shell " +
        `(export GITHUB_TOKEN=...) or put it in ${ENV_LOCAL_RELATIVE_PATH}, then restart dev.`,
    );
  });
});

describe("shadowedBoxSecretNote", () => {
  test("names the variable and its table, and no value", () => {
    expect(shadowedBoxSecretNote({ variable: "GITHUB_TOKEN", table: "[egress.github]" })).toBe(
      "GITHUB_TOKEN, which [egress.github] of the box profile reads, is set in this shell and in " +
        `${ENV_LOCAL_RELATIVE_PATH} to different values; box uses the shell's`,
    );
  });
});
