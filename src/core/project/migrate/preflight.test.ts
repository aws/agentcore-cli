import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { V0AgentCoreProjectSpecSchema } from "../../../projectSchemas/v0";
import { v0Fixture } from "../legacy/fixtures-test-support";
import { F1_SPEC, fakeGit, writeV0Project, type V0ProjectFiles } from "./migrate-test-support";
import {
  checkCdkPin,
  checkDeployedState,
  checkGit,
  checkProjectFormat,
  checkSupportedResources,
  OLD_CDK_MESSAGE,
  PRESERVE_RESOURCES_DOCS_URL,
  preflight,
} from "./preflight";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

describe("checkProjectFormat", () => {
  test("accepts a v0 project and returns its parsed spec", async () => {
    const result = await checkProjectFormat(await project());
    expect(result.check).toEqual({
      name: "v0 project",
      ok: true,
      message: "'CompatA' is a v0 project",
    });
    expect(result.v0Spec?.name).toBe("CompatA");
  });

  test("says a v1 project has nothing to migrate", async () => {
    const result = await checkProjectFormat(
      await project({ spec: { name: "Already", version: 2, managedBy: "CDK" } }),
    );
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("already a v1 project");
    expect(result.v0Spec).toBeUndefined();
  });

  test("rejects an unknown version", async () => {
    const result = await checkProjectFormat(await project({ spec: { ...F1_SPEC, version: 7 } }));
    expect(result.check.message).toContain("has version 7; only v0 projects (version 1)");
  });

  test("reports a spec the v0 schema rejects", async () => {
    const result = await checkProjectFormat(await project({ spec: { ...F1_SPEC, name: "1bad" } }));
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("isn't a valid v0 project");
  });

  test("reports unreadable JSON", async () => {
    const root = await project();
    await writeFile(join(root, "agentcore", "agentcore.json"), "{ not json");
    const result = await checkProjectFormat(root);
    expect(result.check.message).toStartWith("Couldn't read agentcore/agentcore.json");
  });
});

describe("checkGit", () => {
  // The gate itself is tested in gitGate.test.ts; this covers reporting it as a check.
  test("passes a clean working tree", async () => {
    expect(await checkGit("/p", fakeGit({ status: "" }))).toEqual({
      name: "git",
      ok: true,
      message: "working tree is clean",
    });
  });

  test("reports each gate failure as a failed check with the gate's message", async () => {
    const outside = await checkGit("/p", fakeGit({ insideWorkTree: false }));
    expect(outside.ok).toBe(false);
    expect(outside.message).toContain("Run `git init` and commit your project first.");

    const dirty = await checkGit("/p", fakeGit({ status: " M agentcore/agentcore.json\n" }));
    expect(dirty.ok).toBe(false);
    expect(dirty.message).toContain("Uncommitted changes:\n   M agentcore/agentcore.json");

    const untracked = await checkGit("/p", fakeGit({ specTracked: false }));
    expect(untracked.message).toContain("agentcore/agentcore.json isn't committed");

    const missing = await checkGit("/p", fakeGit({ missing: true }));
    expect(missing.message).toContain("git isn't installed or isn't on PATH");
  });

  test("asks git about the project directory", async () => {
    const commands: string[][] = [];
    const git = fakeGit({});
    await checkGit("/p", async (command, options) => {
      commands.push(command);
      await git(command, options);
    });
    expect(commands.every((command) => command.slice(0, 3).join(" ") === "git -C /p")).toBe(true);
  });
});

describe("checkCdkPin", () => {
  test.each(["0.1.0-alpha.45", "0.1.0-alpha.54", "0.1.0-alpha.100"])("accepts %s", async (pin) => {
    expect((await checkCdkPin(await project({ cdkPin: pin }))).ok).toBe(true);
  });

  test.each(["0.1.0-alpha.44", "0.1.0-alpha.9", "^0.1.0-alpha.54", "1.0.0"])(
    "rejects %s with the update guidance",
    async (pin) => {
      expect(await checkCdkPin(await project({ cdkPin: pin }))).toEqual({
        name: "cdk dependencies",
        ok: false,
        message: OLD_CDK_MESSAGE,
      });
    },
  );

  test("reports a missing CDK app manifest", async () => {
    const check = await checkCdkPin(await project({ cdkPin: null }));
    expect(check.ok).toBe(false);
    expect(check.message).toStartWith("Couldn't read agentcore/cdk/package.json");
  });
});

describe("checkSupportedResources", () => {
  const without = (spec: ReturnType<typeof v0Fixture>, ...drop: Array<"insights" | "capacity">) =>
    ({
      ...spec,
      ...(drop.includes("insights") && {
        onlineEvalConfigs: spec.onlineEvalConfigs.filter((config) => config.insights === undefined),
      }),
      ...(drop.includes("capacity") && {
        capacityProviders: [],
        runtimes: spec.runtimes.map(
          ({ capacityProviderConfiguration: _cp, filesystemConfigurations: _fs, ...runtime }) =>
            runtime,
        ),
      }),
    }) as typeof spec;

  test("passes a project without unsupported resources", () => {
    expect(checkSupportedResources(V0AgentCoreProjectSpecSchema.parse(F1_SPEC))).toEqual({
      name: "supported resources",
      ok: true,
      message: "no capacity providers or runtimes on them",
    });
  });

  test("lets knowledge bases, datasets, and online insights through to be retained", () => {
    const spec = without(v0Fixture("baseline.json"), "insights", "capacity");
    expect(spec.knowledgeBases.length).toBeGreaterThan(0);
    expect(checkSupportedResources(spec).ok).toBe(true);
    expect(checkSupportedResources(v0Fixture("top-datasets-nonempty.json")).message).not.toContain(
      "datasets",
    );
    const insightsOnly = without(v0Fixture("baseline.json"), "capacity");
    expect(insightsOnly.onlineEvalConfigs.some((config) => config.insights !== undefined)).toBe(
      true,
    );
    expect(checkSupportedResources(insightsOnly).ok).toBe(true);
  });

  test("lists what still blocks on one summary line, and says why in the full message", () => {
    const check = checkSupportedResources(v0Fixture("runtime-capacityProvider.json"));
    expect(check.ok).toBe(false);
    expect(check.summary).toStartWith(
      "Migration blocked: This project uses resources that v1 doesn't support yet: ",
    );
    expect(check.summary).toContain("capacity providers (");
    expect(check.summary).not.toContain("online insights");
    expect(check.message).toContain("compatibility mode");
    expect(check.message).toEndWith(`See ${PRESERVE_RESOURCES_DOCS_URL}`);
  });

  test("never tells the user to delete anything", () => {
    for (const fixture of ["baseline.json", "runtime-capacityProviderArn-only.json"]) {
      const { message } = checkSupportedResources(v0Fixture(fixture));
      expect(message).not.toMatch(/delet|remove them/i);
    }
  });

  test("blocks capacity providers and the runtimes that use them, saying why", () => {
    const check = checkSupportedResources(v0Fixture("runtime-capacityProviderArn-only.json"));
    expect(check.ok).toBe(false);
    expect(check.summary).toContain("runtimes on capacity providers (");
    expect(check.message).toContain("runtimes run on them");
    expect(checkSupportedResources(v0Fixture("runtime-capacityProvider.json")).summary).toContain(
      "capacity providers (",
    );
  });
});

describe("checkCdkPin with a local library build", () => {
  test("says it's a local build, not an old one, with a next step", async () => {
    const root = await project();
    const path = join(root, "agentcore", "cdk", "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["@aws/agentcore-cdk"] = "file:../../libs/aws-agentcore-cdk-1.0.0.tgz";
    writeFileSync(path, JSON.stringify(manifest));
    const check = await checkCdkPin(root);
    expect(check.ok).toBe(false);
    expect(check.message).toContain(
      "agentcore/cdk uses a local @aws/agentcore-cdk build (file:../../libs/aws-agentcore-cdk-1.0.0.tgz)",
    );
    expect(check.message).not.toContain("older than");
    expect(check.message).toContain("`agentcore migrate` again");
  });
});

describe("checkDeployedState", () => {
  test("treats a never-deployed project as having nothing to keep", async () => {
    const result = await checkDeployedState(await project({ deployedState: null }));
    expect(result.check).toEqual({
      name: "deployed state",
      ok: true,
      message: "never deployed; no names to keep",
    });
    expect(result.state).toEqual({ targets: {} });
  });

  test("names the deployed targets", async () => {
    const result = await checkDeployedState(await project());
    expect(result.check.message).toBe("deployed to 'default'");
    expect(Object.keys(result.state.targets)).toEqual(["default"]);
  });

  test("fails on state v0 couldn't have written", async () => {
    const result = await checkDeployedState(
      await project({
        deployedState: { targets: { default: { resources: { runtimes: { a: {} } } } } },
      }),
    );
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("isn't valid v0 deployed state");
  });
});

describe("preflight", () => {
  test("runs every check for a v0 project", async () => {
    const result = await preflight(
      await project({ cdkPin: "0.1.0-alpha.40" }),
      fakeGit({ status: "?? x" }),
    );
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["v0 project", true],
      ["git", false],
      ["cdk dependencies", false],
      ["cdk app", true],
      ["supported resources", true],
      ["deployed state", true],
    ]);
    expect(result.context?.v0Spec.name).toBe("CompatA");
  });

  test("stops after the format check when the project isn't v0", async () => {
    const result = await preflight(
      await project({ spec: { name: "Already", version: 2 } }),
      fakeGit({ status: "" }),
    );
    expect(result.checks.map((check) => check.name)).toEqual(["v0 project"]);
    expect(result.context).toBeUndefined();
  });
});
