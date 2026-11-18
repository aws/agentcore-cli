import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSpec } from "../../projectSchemas/project";
import { boxNetworkFailureMessage, readBoxNetworks } from "./boxNetworkSource";

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

/** A project root whose profile names `policies`, with `.box/agent/local/policy.dw` in it. */
async function project(policies: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "box-network-source-"));
  directories.push(root);
  await mkdir(join(root, ".box", "agent", "local"), { recursive: true });
  await writeFile(
    join(root, ".box", "agent", "local", "profile.toml"),
    `policies = ${JSON.stringify(policies)}\n[egress.api]\ndestinations = ["api.example.com"]\n`,
  );
  await writeFile(join(root, ".box", "agent", "local", "policy.dw"), "// no rule\n");
  return root;
}

const failuresOf = (root: string) =>
  readBoxNetworks(SPEC, root)[0]!.failures.map(({ code, reason, place }) => ({
    code,
    reason,
    place,
  }));

describe("readBoxNetworks", () => {
  test("reads the profile and its policy files into one model per box runtime", async () => {
    const root = await project(["policy.dw"]);

    const [network] = readBoxNetworks(SPEC, root);

    expect(network?.gateway).toBe("agent-box");
    expect(network?.policyFiles).toEqual(["policy.dw"]);
    expect(network?.hosts.map(({ target }) => target)).toEqual(["egress-api"]);
  });

  test("builds no model for a project that is not a Box project", async () => {
    expect(readBoxNetworks({ ...SPEC, projectType: undefined }, await project([]))).toEqual([]);
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
    await symlink(elsewhere, join(root, ".box", "agent", "local", "outside.dw"));
    await link(
      join(root, ".box", "agent", "local", "policy.dw"),
      join(root, ".box", "agent", "local", "linked.dw"),
    );
    await mkdir(join(root, ".box", "agent", "local", "folder.dw"));

    expect(failuresOf(root)).toEqual([
      expect.objectContaining({
        place: ".box/agent/local/missing.dw",
        reason: expect.stringContaining("does not exist"),
      }),
      expect.objectContaining({
        place: ".box/agent/local/outside.dw",
        reason: expect.stringContaining("a symlink that leaves the agent's local box folder"),
      }),
      expect.objectContaining({
        place: ".box/agent/local/linked.dw",
        reason: expect.stringContaining("has 2 hard links"),
      }),
      expect.objectContaining({
        place: ".box/agent/local/folder.dw",
        reason: expect.stringContaining("is a directory"),
      }),
      expect.objectContaining({
        place: ".box/agent/local/box",
        reason: expect.stringContaining("takes the name box"),
      }),
      expect.objectContaining({
        place: ".box/agent/local/a b.dw",
        reason: expect.stringContaining("cannot copy"),
      }),
    ]);
  });

  test("reads a symlink that stays inside the agent's local box folder", async () => {
    const root = await project(["inner.dw"]);
    await symlink(
      join(root, ".box", "agent", "local", "policy.dw"),
      join(root, ".box", "agent", "local", "inner.dw"),
    );

    expect(failuresOf(root)).toEqual([]);
  });
});

describe("boxNetworkFailureMessage", () => {
  test("lists every failure of an agent under its own profile, and says nothing was written", async () => {
    // Each boxed agent reads its own .box/<name>/local profile, so a failure names that path.
    const root = await project(["missing.dw"]);

    expect(boxNetworkFailureMessage(readBoxNetworks(SPEC, root))).toBe(
      ".box/agent/local/profile.toml does not parse into the Box network of the Box gateway " +
        "'agent-box' of runtime 'agent' (1 failure):\n" +
        "  - INVALID_POLICY_FILE, at .box/agent/local/missing.dw: .box/agent/local/profile.toml " +
        "names the policy file .box/agent/local/missing.dw, which does not exist\n\n" +
        "Nothing of the box profile was written: no gateway target, credential, Memory target, " +
        "or file. Change the profile or its policy files, then retry.",
    );
  });
});
