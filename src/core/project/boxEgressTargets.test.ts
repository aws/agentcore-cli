import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors/errors";
import { getBoxGatewayBedrockEntry } from "../../handlers/project/shortcuts";
import type { ProjectSpec } from "../../projectSchemas/project";
import { getBoxEgressTargetSpec } from "./boxEgress";
import { addBoxEgressTargets } from "./boxEgressTargets";

const GITHUB_EGRESS =
  '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function root(toml?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "box-egress-targets-"));
  directories.push(directory);
  if (toml !== undefined) {
    await mkdir(join(directory, ".box"), { recursive: true });
    await writeFile(join(directory, ".box", "profile.toml"), toml);
  }
  return directory;
}

function spec(options: { entrypoint?: string } = {}): ProjectSpec {
  return {
    name: "demo",
    projectType: "box",
    runtimes: [
      {
        name: "agent",
        build: "CodeZip",
        entrypoint: options.entrypoint ?? "start.py",
        codeLocation: "app/agent",
      },
    ],
    memories: [],
    agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
    policyEngines: [],
  } as unknown as ProjectSpec;
}

const targets = (project: ProjectSpec) =>
  project.agentCoreGateways
    .find(({ name }) => name === "agent-box")
    ?.targets.map(({ name }) => name);

const expectedTarget = getBoxEgressTargetSpec({
  name: "github",
  destinations: ["api.github.com"],
  endpoint: "https://api.github.com",
  variable: "GITHUB_TOKEN",
  header: "Authorization",
});

describe("addBoxEgressTargets", () => {
  test("adds a passthrough target for an env:// box egress", async () => {
    const project = spec();

    expect(addBoxEgressTargets(project, await root(GITHUB_EGRESS))).toEqual([
      "adding target 'github' to gateway 'agent-box' in agentcore.json, for the box egress to api.github.com",
      "adding policy engine 'agent_box' to agentcore.json, for gateway 'agent-box'",
    ]);
    expect(targets(project)).toEqual(["bedrock", "github"]);
    expect(project.agentCoreGateways[0]!.targets[1]).toEqual(expectedTarget);
  });

  test("changes nothing on a second pass", async () => {
    const project = spec();
    const directory = await root(GITHUB_EGRESS);
    addBoxEgressTargets(project, directory);

    expect(addBoxEgressTargets(project, directory)).toEqual([]);
    expect(targets(project)).toEqual(["bedrock", "github"]);
  });

  test("changes nothing with no box egress, or for a runtime that does not run in a box", async () => {
    expect(addBoxEgressTargets(spec(), await root())).toEqual([]);
    expect(addBoxEgressTargets(spec({ entrypoint: "main.py" }), await root(GITHUB_EGRESS))).toEqual(
      [],
    );
  });

  test("rejects a non-Box gateway that already uses the egress name", async () => {
    const project = spec();
    project.agentCoreGateways.push({
      ...getBoxGatewayBedrockEntry("agent"),
      name: "other",
      targets: [expectedTarget],
    });
    const directory = await root(GITHUB_EGRESS);

    expect(() => addBoxEgressTargets(project, directory)).toThrow(InputValidationError);
  });
});
