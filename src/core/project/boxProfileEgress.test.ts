import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasValue, parseBoxEnvRoutes, readBoxEnvRoutes } from "./boxProfileEgress";

describe("parseBoxEnvRoutes", () => {
  test("lists each env:// route in profile order", () => {
    expect(
      parseBoxEnvRoutes(
        '[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n\n' +
          '[egress.stripe]\nsecret.ref = "env://STRIPE_KEY"\n',
      ),
    ).toEqual({
      routes: [
        { route: "github", variable: "GITHUB_TOKEN" },
        { route: "stripe", variable: "STRIPE_KEY" },
      ],
    });
  });

  test("skips aws:// refs, routes with no secret, and env:// refs with no variable", () => {
    expect(
      parseBoxEnvRoutes(
        '[egress.bedrock]\nsecret.ref = "aws://default"\n\n' +
          '[egress.open]\nhost = "example.com"\n\n' +
          '[egress.empty]\nsecret.ref = "env://"\n\n' +
          '[egress.blank]\nsecret.ref = "env://  "\n',
      ),
    ).toEqual({ routes: [] });
  });

  test("has no routes when egress is not a table", () => {
    expect(parseBoxEnvRoutes('[[egress]]\nsecret.ref = "env://GITHUB_TOKEN"\n')).toEqual({
      routes: [],
    });
    expect(parseBoxEnvRoutes('egress = "none"\n')).toEqual({ routes: [] });
    expect(parseBoxEnvRoutes("")).toEqual({ routes: [] });
  });

  test("reports a profile that does not parse", () => {
    const parsed = parseBoxEnvRoutes("[egress.github\n");

    expect(parsed.routes).toEqual([]);
    expect(parsed.error).toBeString();
  });
});

describe("readBoxEnvRoutes", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("reads the project's .box/profile.toml, or is undefined with no profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "box-profile-egress-"));
    directories.push(root);
    expect(readBoxEnvRoutes(root)).toBeUndefined();

    await mkdir(join(root, ".box"));
    await writeFile(
      join(root, ".box", "profile.toml"),
      '[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n',
    );

    expect(readBoxEnvRoutes(root)).toEqual({
      routes: [{ route: "github", variable: "GITHUB_TOKEN" }],
    });
  });
});

describe("hasValue", () => {
  test("is true only for a set, non-blank value", () => {
    expect(hasValue("k")).toBe(true);
    expect(hasValue(undefined)).toBe(false);
    expect(hasValue("")).toBe(false);
    expect(hasValue(" \t")).toBe(false);
  });
});
