import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors/errors";
import { getBoxGatewayEntry } from "../../handlers/project/shortcuts";
import type { ProjectSpec } from "../../projectSchemas/project";
import { boxNetworkFailureMessage, readBoxNetworks } from "./boxNetworkSource";
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SPEC = {
  name: "demo",
  projectType: "box",
  runtimes: [
    { name: "agent", build: "CodeZip", entrypoint: "start.py", codeLocation: "app/agent" },
  ],
  memories: [],
  credentials: [],
  agentCoreGateways: [],
} as unknown as ProjectSpec;

/** What box resolves the profile of {@link project} to: its route `api`, which has no secret. */
const API_ROUTE = { api: { destinations: ["api.example.com"] } };

/** A project root whose profile names `policies`, with `.box/policy.dw` in it. */
async function project(policies: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
  directories.push(root);
  await mkdir(join(root, ".box"), { recursive: true });
  await writeFile(
    join(root, ".box", "profile.toml"),
    `policies = ${JSON.stringify(policies)}\n[egress.api]\ndestinations = ["api.example.com"]\n`,
  );
  await writeFile(join(root, ".box", "policy.dw"), "// no rule\n");
  return root;
}

const failuresOf = async (root: string) =>
  (await readBoxNetworks(SPEC, root, new FakeBoxProfileResolver()))[0]!.failures.map(
    ({ code, reason, place }) => ({ code, reason, place }),
  );

describe("readBoxNetworks", () => {
  test("reads box's resolution of .box/profile.toml, in the project folder, into one model per box runtime", async () => {
    const root = await project(["policy.dw"]);
    const box = new FakeBoxProfileResolver(
      boxShowOf({ egress: API_ROUTE, policy: "// no rule\n" }),
    );

    const [network] = await readBoxNetworks(SPEC, root, box);

    expect(box.calls).toEqual([{ projectRoot: root, profilePath: ".box/profile.toml" }]);
    expect(network?.gateway).toBe("agent-box");
    expect(network?.policyFiles).toEqual(["policy.dw"]);
    // Box writes a route with no secret only as rules, and the target still takes its name.
    expect(network?.hosts.map(({ target }) => target)).toEqual(["egress-api"]);
  });

  test("places a rule of a policy file at its line, and a rule Box adds as Box's", async () => {
    const root = await project(["policy.dw"]);
    const wild =
      '@id("wild") permit (principal, action == Box::Action::"http:request", resource) when { context.input.host like "*.example.com" };\n';
    await writeFile(join(root, ".box", "policy.dw"), `// every subdomain\n${wild}`);
    const box = new FakeBoxProfileResolver(
      boxShowOf({
        egress: { wide: { destinations: ["*.wide.example.com"], secret: { ref: "env://KEY" } } },
        policy: `// every subdomain\n${wild}`,
      }),
    );

    const [network] = await readBoxNetworks(SPEC, root, box);

    expect(
      network?.failures.map(({ code, ruleId, egressEntry, place }) => [
        code,
        ruleId ?? egressEntry,
        place,
      ]),
    ).toEqual([
      ["EGRESS_WILDCARD_DESTINATION", "wide", undefined],
      ["WILDCARD_HOST", "wild", ".box/policy.dw:2:1"],
    ]);
  });

  test("runs no box for a project that is not a Box project, or that has no box profile", async () => {
    const box = new FakeBoxProfileResolver();
    const root = await project([]);

    expect(await readBoxNetworks({ ...SPEC, projectType: undefined }, root, box)).toEqual([]);
    await rm(join(root, ".box", "profile.toml"));
    expect((await readBoxNetworks(SPEC, root, box))[0]?.hosts).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  test("stops with box's own error when box cannot resolve the profile", async () => {
    const refused = new InvalidEnvironmentError("box: error: a profile holds no `policy`");

    await expect(
      readBoxNetworks(SPEC, await project([]), new FakeBoxProfileResolver(refused)),
    ).rejects.toBe(refused);
  });

  test("refuses a policy file Box would refuse, each at its place", async () => {
    const root = await project([
      "missing.dw",
      "outside.dw",
      "linked.dw",
      "folder.dw",
      "box",
      "a b.dw",
    ]);
    const elsewhere = join(root, "elsewhere.dw");
    await writeFile(elsewhere, "// outside\n");
    await symlink(elsewhere, join(root, ".box", "outside.dw"));
    await link(join(root, ".box", "policy.dw"), join(root, ".box", "linked.dw"));
    await mkdir(join(root, ".box", "folder.dw"));

    expect(await failuresOf(root)).toEqual([
      expect.objectContaining({
        place: ".box/missing.dw",
        reason: expect.stringContaining("does not exist"),
      }),
      expect.objectContaining({
        place: ".box/outside.dw",
        reason: expect.stringContaining("a symlink that leaves .box/"),
      }),
      expect.objectContaining({
        place: ".box/linked.dw",
        reason: expect.stringContaining("has 2 hard links"),
      }),
      expect.objectContaining({
        place: ".box/folder.dw",
        reason: expect.stringContaining("is a directory"),
      }),
      expect.objectContaining({
        place: ".box/box",
        reason: expect.stringContaining("takes the name box"),
      }),
      expect.objectContaining({
        place: ".box/a b.dw",
        reason: expect.stringContaining("cannot copy"),
      }),
    ]);
  });

  test("reads a symlink that stays inside .box/", async () => {
    const root = await project(["inner.dw"]);
    await symlink(join(root, ".box", "policy.dw"), join(root, ".box", "inner.dw"));

    expect(await failuresOf(root)).toEqual([]);
  });
});

describe("the IAM policy files of the Box gateway", () => {
  test("counts the actions of each listed file, and warns for one it cannot count", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    await writeFile(join(root, "agentcore", "broken.json"), "{ not json");
    await writeFile(join(root, "agentcore", "list.json"), "[]");
    await writeFile(
      join(root, "agentcore", "grants.json"),
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: ["bedrock:InvokeModel"] }] }),
    );
    const listed = ["missing", "broken", "list", "grants"].map((name) => `agentcore/${name}.json`);
    const spec = {
      ...SPEC,
      agentCoreGateways: [{ ...getBoxGatewayEntry("agent"), additionalPolicies: listed }],
    } as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["bedrock:InvokeModel"]);
    const tail =
      "so build counts none of its actions when it checks what the gateway's role may sign for";
    // Build writes box-bedrock-policy.json itself, so a missing one is no warning.
    expect(network?.warnings).toEqual([
      `agentcore/missing.json, which additionalPolicies of gateway 'agent-box' lists, does not exist, ${tail}`,
      expect.stringMatching(
        /^agentcore\/broken\.json, which additionalPolicies of gateway 'agent-box' lists, is not valid JSON \(.+\), so build counts none/,
      ),
      `agentcore/list.json, which additionalPolicies of gateway 'agent-box' lists, is not a JSON object, ${tail}`,
    ]);
  });
});

describe("boxNetworkFailureMessage", () => {
  test("lists every failure once for the runtimes that share them, and says nothing was written", async () => {
    const root = await project(["missing.dw"]);
    const spec = {
      ...SPEC,
      runtimes: [...SPEC.runtimes, { ...SPEC.runtimes[0]!, name: "second" }],
    } as ProjectSpec;

    const networks = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(boxNetworkFailureMessage(networks)).toBe(
      ".box/profile.toml does not parse into the Box network of the Box gateway 'agent-box', " +
        "'second-box' of runtimes 'agent', 'second' (1 failure):\n" +
        "  - INVALID_POLICY_FILE, at .box/missing.dw: .box/profile.toml names the policy file " +
        ".box/missing.dw, which does not exist\n\n" +
        "Nothing of the box profile was written: no gateway target, credential, Memory target, " +
        "or file. Change the profile or its policy files, then retry.",
    );
  });
});
