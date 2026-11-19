import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors/errors";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
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
  agentCoreGateways: [boxGatewaySpec("agent")],
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
    expect(network?.gateway).toBe("agent-box-egress");
    expect(network?.policyFiles).toEqual(["policy.dw"]);
    // Box writes a route with no secret only as rules, and the target still takes its name.
    expect(network?.hosts.map(({ target }) => target)).toEqual(["egress-api"]);
  });

  test("finds each runtime's Box gateway by boundRuntime, whatever its name", async () => {
    const root = await project([]);
    const spec = {
      ...SPEC,
      agentCoreGateways: [
        { ...boxGatewaySpec("agent"), name: "agent-box-egress", boundRuntime: undefined },
        { ...boxGatewaySpec("agent"), name: "renamed" },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(
      spec,
      root,
      new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE })),
    );

    expect(network?.gateway).toBe("renamed");
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
    await symlink(elsewhere, join(root, ".box", "outside.dw"));
    await link(join(root, ".box", "policy.dw"), join(root, ".box", "linked.dw"));
    await mkdir(join(root, ".box", "folder.dw"));

    const reasons = await failuresOf(root);
    expect(reasons.map(({ code, place }) => [code, place])).toEqual(
      Array(6).fill(["INVALID_POLICY_FILE", ".box/profile.toml:1:1"]),
    );
    expect(reasons.map(({ reason }) => reason)).toEqual([
      "`policies` names missing.dw, but .box/missing.dw does not exist. Create it, or remove " +
        "it from `policies`.",
      ".box/outside.dw is a symbolic link to a file outside .box/, which Box does not read. Put " +
        "the policy file itself in .box/.",
      ".box/linked.dw has 2 hard links, and Box reads only a policy file with one. Replace it " +
        "with a copy.",
      ".box/folder.dw is a folder, not a policy file. Name a file in `policies`.",
      '.box/box takes the name "box", which Box keeps for its own files on AgentCore Runtime. ' +
        "Rename the file.",
      '.box/a b.dw has a character other than a letter, a digit, ".", "_", "-", or "/" in its ' +
        "path, and deploy cannot copy it to AgentCore Runtime. Rename the file.",
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
      agentCoreGateways: [{ ...boxGatewaySpec("agent"), additionalPolicies: listed }],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual(["bedrock:InvokeModel"]);
    const listing = "in additionalPolicies of the gateway 'agent-box-egress'";
    const check = "so build cannot check the permissions it grants.";
    expect(network?.warnings).toEqual([
      `agentcore/missing.json, ${listing}, does not exist, ${check} Create it, or remove it ` +
        "from additionalPolicies.",
      expect.stringMatching(
        /^agentcore\/broken\.json, in additionalPolicies of the gateway 'agent-box-egress', is not valid JSON \(.+\), so build cannot check the permissions it grants\. Correct the JSON\.$/,
      ),
      `agentcore/list.json, ${listing}, is not a JSON object, ${check} Make it an IAM policy ` +
        "document.",
    ]);
  });

  test("gives no warning for the Memory policy file that build writes before it writes it", async () => {
    const root = await project([]);
    const spec = {
      ...SPEC,
      agentCoreGateways: [
        { ...boxGatewaySpec("agent"), additionalPolicies: ["agentcore/box-memory-policy.json"] },
      ],
    } as unknown as ProjectSpec;

    const [network] = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(network?.grantedActions).toEqual([]);
    expect(network?.warnings).toEqual([]);
  });
});

describe("boxNetworkFailureMessage", () => {
  test("lists a problem of every box runtime once, with no runtime, and says nothing changed", async () => {
    const root = await project(["missing.dw"]);
    const spec = {
      ...SPEC,
      runtimes: [...SPEC.runtimes, { ...SPEC.runtimes[0]!, name: "second" }],
      agentCoreGateways: [boxGatewaySpec("agent"), boxGatewaySpec("second")],
    } as unknown as ProjectSpec;

    const networks = await readBoxNetworks(spec, root, new FakeBoxProfileResolver());

    expect(boxNetworkFailureMessage(networks, "deploy")).toBe(
      "Deploy stopped: 1 problem in the Box profile. Deploy wrote nothing from the Box profile.\n" +
        ".box/profile.toml:1:1  `policies` names missing.dw, but .box/missing.dw does not exist. " +
        "Create it, or remove it from `policies`.",
    );
  });

  test("names the runtime of a problem that only some box runtimes have", async () => {
    const root = await project(["missing.dw"]);
    const spec = {
      ...SPEC,
      runtimes: [...SPEC.runtimes, { ...SPEC.runtimes[0]!, name: "second" }],
      agentCoreGateways: [
        boxGatewaySpec("agent"),
        {
          ...boxGatewaySpec("second"),
          targets: [
            {
              name: "api",
              targetType: "passthrough",
              passthrough: { endpoint: "https://api.example.com/v1", protocolType: "CUSTOM" },
            },
          ],
        },
      ],
    } as unknown as ProjectSpec;

    const networks = await readBoxNetworks(
      spec,
      root,
      new FakeBoxProfileResolver(boxShowOf({ egress: API_ROUTE })),
    );

    expect(boxNetworkFailureMessage(networks, "build")).toBe(
      "Build stopped: 2 problems in the Box profile and agentcore.json. Build wrote nothing from the Box profile.\n" +
        ".box/profile.toml:1:1  `policies` names missing.dw, but .box/missing.dw does not exist. " +
        "Create it, or remove it from `policies`.\n" +
        "In runtime second:\n" +
        "  agentcore/agentcore.json  The gateway target 'api' for api.example.com has the path " +
        "/v1 in its endpoint, and the agent's requests do not include it. Remove /v1 from the " +
        "endpoint, or remove the target.",
    );
  });
});
