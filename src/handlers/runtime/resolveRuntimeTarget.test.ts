import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors";
import { RegionKey } from "../keys";
import { ValueContext } from "../../router";
import type { Core } from "../types";
import type { Project } from "../project/types";
import type { DeployedRuntime } from "./types";
import { resolveRuntimeTarget } from "./resolveRuntimeTarget";

const ctx = ValueContext.EmptyContext().withValue(RegionKey, "us-east-1");

const PROJECT = { name: "Proj", rootPath: "/proj", spec: {} } as unknown as Project;

const DEPLOYED: DeployedRuntime = {
  runtimeId: "proj_agent-AbC123XyZ9",
  region: "eu-west-1",
  stackName: "AgentCore-Proj-default",
  targetName: "default",
};

function stubCore(config: {
  resolve: () => Promise<Project | undefined>;
  deployed?: DeployedRuntime;
}): { core: Core; observabilityCalls: unknown[][] } {
  const observabilityCalls: unknown[][] = [];
  const core = {
    projectManager: { resolve: config.resolve },
    observability: {
      resolveDeployedRuntime: async (project: Project, targetName: string) => {
        observabilityCalls.push([project, targetName]);
        return config.deployed ?? DEPLOYED;
      },
    },
  } as unknown as Core;
  return { core, observabilityCalls };
}

describe("resolveRuntimeTarget", () => {
  test("an explicit --id wins and keeps the ambient region", async () => {
    const { core, observabilityCalls } = stubCore({ resolve: async () => undefined });

    const target = await resolveRuntimeTarget(core, ctx, "explicit-id", tmpdir());

    expect(target.runtimeId).toBe("explicit-id");
    expect(target.options).toEqual({ region: "us-east-1", endpointUrl: undefined });
    expect(target.project).toBeUndefined();
    expect(observabilityCalls).toHaveLength(0);
  });

  test("an explicit --id attaches the enclosing project as context", async () => {
    const { core } = stubCore({ resolve: async () => PROJECT });

    const target = await resolveRuntimeTarget(core, ctx, "explicit-id", "/proj/somewhere");

    expect(target.project).toBe(PROJECT);
  });

  test("an explicit --id survives a broken project spec", async () => {
    const { core } = stubCore({
      resolve: async () => {
        throw new Error("agentcore.json is corrupt");
      },
    });

    const target = await resolveRuntimeTarget(core, ctx, "explicit-id", tmpdir());

    expect(target.runtimeId).toBe("explicit-id");
    expect(target.project).toBeUndefined();
  });

  test("without --id the project's default-target runtime resolves, region included", async () => {
    const { core, observabilityCalls } = stubCore({ resolve: async () => PROJECT });

    const target = await resolveRuntimeTarget(core, ctx, undefined, "/proj/app");

    expect(observabilityCalls).toEqual([[PROJECT, "default"]]);
    expect(target.runtimeId).toBe("proj_agent-AbC123XyZ9");
    // The deployment target's region wins: the stack and log groups live there.
    expect(target.options.region).toBe("eu-west-1");
    expect(target.project).toBe(PROJECT);
  });

  test("without --id and outside a project, a usage error demands --id", async () => {
    const { core } = stubCore({ resolve: async () => undefined });
    const outside = mkdtempSync(join(tmpdir(), "no-project-"));

    await expect(resolveRuntimeTarget(core, ctx, undefined, outside)).rejects.toThrow(
      InputValidationError,
    );
    await expect(resolveRuntimeTarget(core, ctx, undefined, outside)).rejects.toThrow(
      "required option '--id <id>' not specified",
    );
  });
});
