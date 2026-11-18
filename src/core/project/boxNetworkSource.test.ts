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

/** A project root whose profile names `policies`, with `box/agent/local/policy.dw` in it. */
async function project(policies: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
  directories.push(root);
  await mkdir(join(root, "box", "agent", "local"), { recursive: true });
  await writeFile(
    join(root, "box", "agent", "local", "profile.toml"),
    `policies = ${JSON.stringify(policies)}\n[egress.api]\ndestinations = ["api.example.com"]\n`,
  );
  await writeFile(join(root, "box", "agent", "local", "policy.dw"), "// no rule\n");
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

  test("places a rule of a policy file at its line, and an entry at its line in the profile", async () => {
    const root = await project(["policy.dw"]);
    await writeFile(
      join(root, ".box", "profile.toml"),
      'policies = ["policy.dw"]\n\n[egress.wide]\ndestinations = ["*.wide.example.com"]\n' +
        'secret.ref = "env://KEY"\n',
    );
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
      ["EGRESS_WILDCARD_DESTINATION", "wide", ".box/profile.toml:3:1"],
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

  test("refuses a policy file Box would refuse, each at `policies`, and says how to fix it", async () => {
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
    await symlink(elsewhere, join(root, "box", "agent", "local", "outside.dw"));
    await link(
      join(root, "box", "agent", "local", "policy.dw"),
      join(root, "box", "agent", "local", "linked.dw"),
    );
    await mkdir(join(root, "box", "agent", "local", "folder.dw"));

    expect(failuresOf(root)).toEqual([
      expect.objectContaining({
        place: "box/agent/local/missing.dw",
        reason: expect.stringContaining("does not exist"),
      }),
      expect.objectContaining({
        place: "box/agent/local/outside.dw",
        reason: expect.stringContaining("a symlink that leaves the agent's local box folder"),
      }),
      expect.objectContaining({
        place: "box/agent/local/linked.dw",
        reason: expect.stringContaining("has 2 hard links"),
      }),
      expect.objectContaining({
        place: "box/agent/local/folder.dw",
        reason: expect.stringContaining("is a directory"),
      }),
      expect.objectContaining({
        place: "box/agent/local/box",
        reason: expect.stringContaining("takes the name box"),
      }),
      expect.objectContaining({
        place: "box/agent/local/a b.dw",
        reason: expect.stringContaining("cannot copy"),
      }),
    ]);
  });

  test("reads a symlink that stays inside the agent's local box folder", async () => {
    const root = await project(["inner.dw"]);
    await symlink(
      join(root, "box", "agent", "local", "policy.dw"),
      join(root, "box", "agent", "local", "inner.dw"),
    );

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
    const listing = "in additionalPolicies of the gateway 'agent-box'";
    const check = "so build cannot check the permissions it grants.";
    // Build writes box-bedrock-policy.json itself, so a missing one is no warning.
    expect(network?.warnings).toEqual([
      `agentcore/missing.json, ${listing}, does not exist, ${check} Create it, or remove it ` +
        "from additionalPolicies.",
      expect.stringMatching(
        /^agentcore\/broken\.json, in additionalPolicies of the gateway 'agent-box', is not valid JSON \(.+\), so build cannot check the permissions it grants\. Correct the JSON\.$/,
      ),
      `agentcore/list.json, ${listing}, is not a JSON object, ${check} Make it an IAM policy ` +
        "document.",
    ]);
  });

  test("does not count the actions of the policy files that build writes", async () => {
    const root = await project([]);
    await mkdir(join(root, "agentcore"));
    const grant = (action: string) =>
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: [action] }] });
    await writeFile(
      join(root, "agentcore", "box-memory-policy.json"),
      grant("bedrock-agentcore:GetEvent"),
    );
    await writeFile(join(root, "agentcore", "box-bedrock-policy.json"), "{ not json");
    await writeFile(join(root, "agentcore", "grants.json"), grant("lambda:InvokeFunctionUrl"));
    const listed = ["box-memory-policy", "box-bedrock-policy", "grants"].map(
      (name) => `agentcore/${name}.json`,
    );
    const spec = {
      ...SPEC,
      agentCoreGateways: [{ ...getBoxGatewayEntry("agent"), additionalPolicies: listed }],
    } as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["lambda:InvokeFunctionUrl"]);
    expect(network?.warnings).toEqual([]);
  });
});

describe("boxNetworkFailureMessage", () => {
  test("lists every failure of an agent under its own profile, and says nothing was written", async () => {
    // Each boxed agent reads its own box/<name>/local profile, so a failure names that path.
    const root = await project(["missing.dw"]);

    expect(boxNetworkFailureMessage(readBoxNetworks(SPEC, root))).toBe(
      "box/agent/local/profile.toml does not parse into the Box network of the Box gateway " +
        "'agent-box' of runtime 'agent' (1 failure):\n" +
        "  - INVALID_POLICY_FILE, at box/agent/local/missing.dw: box/agent/local/profile.toml " +
        "names the policy file box/agent/local/missing.dw, which does not exist\n\n" +
        "Nothing of the box profile was written: no gateway target, credential, Memory target, " +
        "or file. Change the profile or its policy files, then retry.",
    );
  });
});
